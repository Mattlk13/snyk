import * as Debug from 'debug';
import * as depGraphLib from '@snyk/dep-graph';
import * as snyk from '..';
import { apiTokenExists } from '../api-token';
import request = require('../request');
import * as config from '../config';
import * as os from 'os';
import * as _ from '@snyk/lodash';
import { isCI } from '../is-ci';
import * as analytics from '../analytics';
import { DepTree, MonitorMeta, MonitorResult } from '../types';
import * as projectMetadata from '../project-metadata';

import {
  MonitorError,
  ConnectionTimeoutError,
  AuthFailedError,
  FailedToRunTestError,
} from '../errors';
import { pruneGraph } from '../prune';
import { GRAPH_SUPPORTED_PACKAGE_MANAGERS } from '../package-managers';
import { isFeatureFlagSupportedForOrg } from '../feature-flags';
import { countTotalDependenciesInTree } from './count-total-deps-in-tree';
import { filterOutMissingDeps } from './filter-out-missing-deps';
import { dropEmptyDeps } from './drop-empty-deps';
import { pruneTree } from './prune-dep-tree';
import { pluckPolicies } from '../policy';
import { PluginMetadata } from '@snyk/cli-interface/legacy/plugin';
import { CallGraph, ScannedProject } from '@snyk/cli-interface/legacy/common';
import { isGitTarget } from '../project-metadata/types';
import { serializeCallGraphWithMetrics } from '../reachable-vulns';
import {
  getNameDepTree,
  getNameDepGraph,
  getProjectName,
  getTargetFile,
} from './utils';
import { countPathsToGraphRoot } from '../utils';

const debug = Debug('snyk');

// TODO(kyegupov): clean up the type, move to snyk-cli-interface repository

interface MonitorBody {
  meta: Meta;
  policy: string;
  package?: DepTree;
  callGraph?: CallGraph;
  target: {};
  targetFileRelativePath: string;
  targetFile: string;
  contributors?: { userId: string; lastCommitDate: string }[];
}

interface Meta {
  method?: string;
  hostname: string;
  id: string;
  ci: boolean;
  pid: number;
  node: string;
  master: boolean;
  name: string;
  version: string;
  org?: string;
  pluginName: string;
  pluginRuntime: string;
  dockerImageId?: string;
  dockerBaseImage?: string;
  projectName: string;
}

export async function monitor(
  root: string,
  meta: MonitorMeta,
  scannedProject: ScannedProject,
  options,
  pluginMeta: PluginMetadata,
  targetFileRelativePath?: string,
  contributors?: { userId: string; lastCommitDate: string }[],
): Promise<MonitorResult> {
  apiTokenExists();

  const packageManager = meta.packageManager;
  analytics.add('packageManager', packageManager);
  analytics.add('isDocker', !!meta.isDocker);

  if (scannedProject.depGraph) {
    return await monitorDepGraph(
      root,
      meta,
      scannedProject,
      pluginMeta,
      targetFileRelativePath,
      contributors,
    );
  }

  // TODO @boost: delete this once 'experimental-dep-graph' ff is deleted
  if (GRAPH_SUPPORTED_PACKAGE_MANAGERS.includes(packageManager)) {
    const monitorGraphSupportedRes = await isFeatureFlagSupportedForOrg(
      _.camelCase('experimental-dep-graph'),
      options.org || config.org,
    );

    if (monitorGraphSupportedRes.code === 401) {
      throw AuthFailedError(
        monitorGraphSupportedRes.error,
        monitorGraphSupportedRes.code,
      );
    }
    if (monitorGraphSupportedRes.ok) {
      return await experimentalMonitorDepGraphFromDepTree(
        root,
        meta,
        scannedProject,
        pluginMeta,
        targetFileRelativePath,
        contributors,
      );
    }
    if (monitorGraphSupportedRes.userMessage) {
      debug(monitorGraphSupportedRes.userMessage);
    }
  }

  return await monitorDepTree(
    root,
    meta,
    scannedProject,
    pluginMeta,
    targetFileRelativePath,
    contributors,
  );
}

async function monitorDepTree(
  root: string,
  meta: MonitorMeta,
  scannedProject: ScannedProject,
  pluginMeta: PluginMetadata,
  targetFileRelativePath?: string,
  contributors?: { userId: string; lastCommitDate: string }[],
): Promise<MonitorResult> {
  let treeMissingDeps: string[] = [];

  const packageManager = meta.packageManager;

  let depTree = scannedProject.depTree;

  if (!depTree) {
    debug(
      'scannedProject is missing depGraph or depTree, cannot run test/monitor',
    );
    throw new FailedToRunTestError(
      'Your monitor request could not be completed. Please email support@snyk.io',
    );
  }

  let prePruneDepCount;
  if (meta.prune) {
    debug('prune used, counting total dependencies');
    prePruneDepCount = countTotalDependenciesInTree(depTree);
    analytics.add('prePruneDepCount', prePruneDepCount);
    debug('total dependencies: %d', prePruneDepCount);
    debug('pruning dep tree');
    depTree = await pruneTree(depTree, meta.packageManager);
    debug('finished pruning dep tree');
  }
  if (['npm', 'yarn'].includes(meta.packageManager)) {
    const { filteredDepTree, missingDeps } = filterOutMissingDeps(depTree);
    depTree = filteredDepTree;
    treeMissingDeps = missingDeps;
  }

  const policyPath = meta['policy-path'] || root;
  const policyLocations = [policyPath]
    .concat(pluckPolicies(depTree))
    .filter(Boolean);
  // docker doesn't have a policy as it can be run from anywhere
  if (!meta.isDocker || !policyLocations.length) {
    await snyk.policy.create();
  }
  const policy = await snyk.policy.load(policyLocations, { loose: true });

  const target = await projectMetadata.getInfo(scannedProject, meta, depTree);

  if (isGitTarget(target) && target.branch) {
    analytics.add('targetBranch', target.branch);
  }

  depTree = dropEmptyDeps(depTree);

  let callGraphPayload;
  if (scannedProject.callGraph) {
    const { callGraph, nodeCount, edgeCount } = serializeCallGraphWithMetrics(
      scannedProject.callGraph,
    );
    debug(
      `Adding call graph to payload, node count: ${nodeCount}, edge count: ${edgeCount}`,
    );

    const callGraphMetrics = _.get(pluginMeta, 'meta.callGraphMetrics', {});
    analytics.add('callGraphMetrics', {
      callGraphEdgeCount: edgeCount,
      callGraphNodeCount: nodeCount,
      ...callGraphMetrics,
    });
    callGraphPayload = callGraph;
  }

  // TODO(kyegupov): async/await
  return new Promise((resolve, reject) => {
    if (!depTree) {
      debug(
        'scannedProject is missing depGraph or depTree, cannot run test/monitor',
      );
      return reject(
        new FailedToRunTestError(
          'Your monitor request could not be completed. Please email support@snyk.io',
        ),
      );
    }
    request(
      {
        body: {
          meta: {
            method: meta.method,
            hostname: os.hostname(),
            id: snyk.id || depTree.name,
            ci: isCI(),
            pid: process.pid,
            node: process.version,
            master: snyk.config.isMaster,
            name: getNameDepTree(scannedProject, depTree, meta),
            version: depTree.version,
            org: config.org ? decodeURIComponent(config.org) : undefined,
            pluginName: pluginMeta.name,
            pluginRuntime: pluginMeta.runtime,
            missingDeps: treeMissingDeps,
            dockerImageId: pluginMeta.dockerImageId,
            dockerBaseImage: depTree.docker
              ? depTree.docker.baseImage
              : undefined,
            dockerfileLayers: depTree.docker
              ? depTree.docker.dockerfileLayers
              : undefined,
            projectName: getProjectName(scannedProject, meta),
            prePruneDepCount, // undefined unless 'prune' is used,
            monitorGraph: false,
            versionBuildInfo: JSON.stringify(
              scannedProject.meta?.versionBuildInfo,
            ),
          },
          policy: policy ? policy.toString() : undefined,
          package: depTree,
          callGraph: callGraphPayload,
          // we take the targetFile from the plugin,
          // because we want to send it only for specific package-managers
          target,
          // WARNING: be careful changing this as it affects project uniqueness
          targetFile: getTargetFile(scannedProject, pluginMeta),
          targetFileRelativePath,
          contributors: contributors,
        } as MonitorBody,
        gzip: true,
        method: 'PUT',
        headers: {
          authorization: 'token ' + snyk.api,
          'content-encoding': 'gzip',
        },
        url: config.API + '/monitor/' + packageManager,
        json: true,
      },
      (error, res, body) => {
        if (error) {
          return reject(error);
        }

        if (res.statusCode >= 200 && res.statusCode <= 299) {
          resolve(body as MonitorResult);
        } else {
          let err;
          const userMessage = body && body.userMessage;
          if (!userMessage && res.statusCode === 504) {
            err = new ConnectionTimeoutError();
          } else {
            err = new MonitorError(res.statusCode, userMessage);
          }
          reject(err);
        }
      },
    );
  });
}

export async function monitorDepGraph(
  root: string,
  meta: MonitorMeta,
  scannedProject: ScannedProject,
  pluginMeta: PluginMetadata,
  targetFileRelativePath?: string,
  contributors?: { userId: string; lastCommitDate: string }[],
): Promise<MonitorResult> {
  const packageManager = meta.packageManager;
  analytics.add('monitorDepGraph', true);

  let depGraph = scannedProject.depGraph;

  if (!depGraph) {
    debug(
      'scannedProject is missing depGraph or depTree, cannot run test/monitor',
    );
    throw new FailedToRunTestError(
      'Your monitor request could not be completed. Please email support@snyk.io',
    );
  }

  const policyPath = meta['policy-path'] || root;
  const policyLocations = [policyPath]
    .concat(pluckPolicies(depGraph))
    .filter(Boolean);

  if (!policyLocations.length) {
    await snyk.policy.create();
  }

  const policy = await snyk.policy.load(policyLocations, { loose: true });
  const target = await projectMetadata.getInfo(scannedProject, meta);
  if (isGitTarget(target) && target.branch) {
    analytics.add('targetBranch', target.branch);
  }

  // this graph will be pruned only if is too dense
  depGraph = await pruneGraph(depGraph, packageManager);

  return new Promise((resolve, reject) => {
    if (!depGraph) {
      debug(
        'scannedProject is missing depGraph or depTree, cannot run test/monitor',
      );
      return reject(
        new FailedToRunTestError(
          'Your monitor request could not be completed. Please email support@snyk.io',
        ),
      );
    }
    request(
      {
        body: {
          meta: {
            method: meta.method,
            hostname: os.hostname(),
            id: snyk.id || depGraph.rootPkg.name,
            ci: isCI(),
            pid: process.pid,
            node: process.version,
            master: snyk.config.isMaster,
            name: getNameDepGraph(scannedProject, depGraph, meta),
            version: depGraph.rootPkg.version,
            org: config.org ? decodeURIComponent(config.org) : undefined,
            pluginName: pluginMeta.name,
            pluginRuntime: pluginMeta.runtime,
            projectName: getProjectName(scannedProject, meta),
            monitorGraph: true,
            versionBuildInfo: JSON.stringify(
              scannedProject.meta?.versionBuildInfo,
            ),
          },
          policy: policy ? policy.toString() : undefined,
          depGraphJSON: depGraph, // depGraph will be auto serialized to JSON on send
          // we take the targetFile from the plugin,
          // because we want to send it only for specific package-managers
          target,
          targetFile: getTargetFile(scannedProject, pluginMeta),
          targetFileRelativePath,
          contributors: contributors,
        } as MonitorBody,
        gzip: true,
        method: 'PUT',
        headers: {
          authorization: 'token ' + snyk.api,
          'content-encoding': 'gzip',
        },
        url: `${config.API}/monitor/${packageManager}/graph`,
        json: true,
      },
      (error, res, body) => {
        if (error) {
          return reject(error);
        }
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          resolve(body as MonitorResult);
        } else {
          let err;
          const userMessage = body && body.userMessage;
          if (!userMessage && res.statusCode === 504) {
            err = new ConnectionTimeoutError();
          } else {
            err = new MonitorError(res.statusCode, userMessage);
          }
          reject(err);
        }
      },
    );
  });
}

/**
 * @deprecated it will be deleted once experimentalDepGraph FF will be deleted
 and npm, yarn, sbt and rubygems usage of `experimentalMonitorDepGraphFromDepTree`
 will be replaced with `monitorDepGraph` method
 */
async function experimentalMonitorDepGraphFromDepTree(
  root: string,
  meta: MonitorMeta,
  scannedProject: ScannedProject,
  pluginMeta: PluginMetadata,
  targetFileRelativePath?: string,
  contributors?: { userId: string; lastCommitDate: string }[],
): Promise<MonitorResult> {
  const packageManager = meta.packageManager;
  analytics.add('experimentalMonitorDepGraphFromDepTree', true);

  let treeMissingDeps: string[];
  let depTree = scannedProject.depTree;

  if (!depTree) {
    debug(
      'scannedProject is missing depGraph or depTree, cannot run test/monitor',
    );
    throw new FailedToRunTestError(
      'Your monitor request could not be completed. Please email support@snyk.io',
    );
  }

  const policyPath = meta['policy-path'] || root;
  const policyLocations = [policyPath]
    .concat(pluckPolicies(depTree))
    .filter(Boolean);

  if (['npm', 'yarn'].includes(meta.packageManager)) {
    const { filteredDepTree, missingDeps } = filterOutMissingDeps(depTree);
    depTree = filteredDepTree;
    treeMissingDeps = missingDeps;
  }

  const depGraph: depGraphLib.DepGraph = await depGraphLib.legacy.depTreeToGraph(
    depTree,
    packageManager,
  );

  // docker doesn't have a policy as it can be run from anywhere
  if (!meta.isDocker || !policyLocations.length) {
    await snyk.policy.create();
  }
  const policy = await snyk.policy.load(policyLocations, { loose: true });

  const target = await projectMetadata.getInfo(scannedProject, meta, depTree);

  if (isGitTarget(target) && target.branch) {
    analytics.add('targetBranch', target.branch);
  }

  let prunedGraph = depGraph;
  let prePruneDepCount;
  if (meta.prune) {
    debug('Trying to prune the graph');
    prePruneDepCount = countPathsToGraphRoot(depGraph);
    debug('pre prunedPathsCount: ' + prePruneDepCount);
    prunedGraph = await pruneGraph(depGraph, packageManager, meta.prune);
  }

  return new Promise((resolve, reject) => {
    if (!depTree) {
      debug(
        'scannedProject is missing depGraph or depTree, cannot run test/monitor',
      );
      return reject(
        new FailedToRunTestError(
          'Your monitor request could not be completed. Please email support@snyk.io',
        ),
      );
    }
    request(
      {
        body: {
          meta: {
            method: meta.method,
            hostname: os.hostname(),
            id: snyk.id || depTree.name,
            ci: isCI(),
            pid: process.pid,
            node: process.version,
            master: snyk.config.isMaster,
            name: getNameDepGraph(scannedProject, depGraph, meta),
            version: depGraph.rootPkg.version,
            org: config.org ? decodeURIComponent(config.org) : undefined,
            pluginName: pluginMeta.name,
            pluginRuntime: pluginMeta.runtime,
            dockerImageId: pluginMeta.dockerImageId,
            dockerBaseImage: depTree.docker
              ? depTree.docker.baseImage
              : undefined,
            dockerfileLayers: depTree.docker
              ? depTree.docker.dockerfileLayers
              : undefined,
            projectName: getProjectName(scannedProject, meta),
            prePruneDepCount, // undefined unless 'prune' is used
            missingDeps: treeMissingDeps,
            monitorGraph: true,
          },
          policy: policy ? policy.toString() : undefined,
          depGraphJSON: prunedGraph, // depGraph will be auto serialized to JSON on send
          // we take the targetFile from the plugin,
          // because we want to send it only for specific package-managers
          target,
          targetFile: getTargetFile(scannedProject, pluginMeta),
          targetFileRelativePath,
          contributors: contributors,
        } as MonitorBody,
        gzip: true,
        method: 'PUT',
        headers: {
          authorization: 'token ' + snyk.api,
          'content-encoding': 'gzip',
        },
        url: `${config.API}/monitor/${packageManager}/graph`,
        json: true,
      },
      (error, res, body) => {
        if (error) {
          return reject(error);
        }

        if (res.statusCode >= 200 && res.statusCode <= 299) {
          resolve(body as MonitorResult);
        } else {
          let err;
          const userMessage = body && body.userMessage;
          if (!userMessage && res.statusCode === 504) {
            err = new ConnectionTimeoutError();
          } else {
            err = new MonitorError(res.statusCode, userMessage);
          }
          reject(err);
        }
      },
    );
  });
}
