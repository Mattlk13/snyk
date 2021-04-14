import * as debugLib from 'debug';
import * as pathLib from 'path';
const sortBy = require('lodash.sortby');
const groupBy = require('lodash.groupby');

import {
  EntityToFix,
  FixChangesSummary,
  FixOptions,
  RemediationChanges,
  Workspace,
} from '../../../../types';
import { FixedCache, PluginFixResponse } from '../../../types';
import { updateDependencies } from './update-dependencies';
import { MissingRemediationDataError } from '../../../../lib/errors/missing-remediation-data';
import { MissingFileNameError } from '../../../../lib/errors/missing-file-name';
import { partitionByFixable } from './is-supported';
import { NoFixesCouldBeAppliedError } from '../../../../lib/errors/no-fixes-applied';
import { extractProvenance } from './extract-version-provenance';
import {
  ParsedRequirements,
  parseRequirementsFile,
} from './update-dependencies/requirements-file-parser';
import { standardizePackageName } from './update-dependencies/standardize-package-name';
import { containsRequireDirective } from './contains-require-directive';

const debug = debugLib('snyk-fix:python:requirements.txt');

export async function pipRequirementsTxt(
  entities: EntityToFix[],
  options: FixOptions,
): Promise<PluginFixResponse> {
  debug(`Preparing to fix ${entities.length} Python requirements.txt projects`);
  const handlerResult: PluginFixResponse = {
    succeeded: [],
    failed: [],
    skipped: [],
  };

  const { fixable, skipped: notFixable } = await partitionByFixable(entities);
  handlerResult.skipped.push(...notFixable);

  const ordered = sortByDirectory(fixable);
  let fixedFilesCache: FixedCache = {};
  for (const dir of Object.keys(ordered)) {
    debug(`Fixing entities in directory ${dir}`);
    const entitiesPerDirectory = ordered[dir].map((e) => e.entity);
    const { failed, succeeded, skipped, fixedCache } = await fixAll(
      entitiesPerDirectory,
      options,
      fixedFilesCache,
    );
    fixedFilesCache = {
      ...fixedFilesCache,
      ...fixedCache,
    };
    handlerResult.succeeded.push(...succeeded);
    handlerResult.failed.push(...failed);
    handlerResult.skipped.push(...skipped);
  }
  return handlerResult;
}

export function getRequiredData(
  entity: EntityToFix,
): {
  remediation: RemediationChanges;
  targetFile: string;
  workspace: Workspace;
} {
  const { remediation } = entity.testResult;
  if (!remediation) {
    throw new MissingRemediationDataError();
  }
  const { targetFile } = entity.scanResult.identity;
  if (!targetFile) {
    throw new MissingFileNameError();
  }
  const { workspace } = entity;
  if (!workspace) {
    throw new NoFixesCouldBeAppliedError();
  }
  return { targetFile, remediation, workspace };
}

async function fixAll(
  entities: EntityToFix[],
  options: FixOptions,
  fixedCache: FixedCache,
): Promise<PluginFixResponse & { fixedCache: FixedCache }> {
  const handlerResult: PluginFixResponse = {
    succeeded: [],
    failed: [],
    skipped: [],
  };
  for (const entity of entities) {
    const targetFile = entity.scanResult.identity.targetFile!;
    try {
      const { dir, base } = pathLib.parse(targetFile);
      // parse & join again to support correct separator
      const filePath = pathLib.normalize(pathLib.join(dir, base));
      if (
        Object.keys(fixedCache).includes(
          pathLib.normalize(pathLib.join(dir, base)),
        )
      ) {
        handlerResult.succeeded.push({
          original: entity,
          changes: [
            {
              success: true,
              userMessage: `Fixed through ${fixedCache[filePath].fixedIn}`,
            },
          ],
        });
        continue;
      }
      const { changes, fixedMeta } = await applyAllFixes(entity, options);
      if (!changes.length) {
        debug('Manifest has not changed!');
        throw new NoFixesCouldBeAppliedError();
      }
      Object.keys(fixedMeta).forEach((f) => {
        fixedCache[f] = {
          fixedIn: targetFile,
        };
      });
      handlerResult.succeeded.push({ original: entity, changes });
    } catch (e) {
      debug(`Failed to fix ${targetFile}.\nERROR: ${e}`);
      handlerResult.failed.push({ original: entity, error: e });
    }
  }
  return { ...handlerResult, fixedCache };
}

// TODO: optionally verify the deps install
export async function fixIndividualRequirementsTxt(
  workspace: Workspace,
  dir: string,
  entryFileName: string,
  fileName: string,
  remediation: RemediationChanges,
  parsedRequirements: ParsedRequirements,
  options: FixOptions,
  directUpgradesOnly: boolean,
): Promise<{ changes: FixChangesSummary[]; appliedRemediation: string[] }> {
  const fullFilePath = pathLib.normalize(pathLib.join(dir, fileName));
  const { updatedManifest, changes, appliedRemediation } = updateDependencies(
    parsedRequirements,
    remediation.pin,
    directUpgradesOnly,
    pathLib.normalize(pathLib.join(dir, entryFileName)) !== fullFilePath
      ? fullFilePath
      : undefined,
  );

  if (!changes.length) {
    return { changes, appliedRemediation };
  }

  if (!options.dryRun) {
    debug('Writing changes to file');
    await workspace.writeFile(pathLib.join(dir, fileName), updatedManifest);
  } else {
    debug('Skipping writing changes to file in --dry-run mode');
  }

  return { changes, appliedRemediation };
}

export async function applyAllFixes(
  entity: EntityToFix,
  options: FixOptions,
): Promise<{
  changes: FixChangesSummary[];
  fixedMeta: { [filePath: string]: FixChangesSummary[] };
}> {
  const { remediation, targetFile: entryFileName, workspace } = getRequiredData(
    entity,
  );
  const fixedMeta: {
    [filePath: string]: FixChangesSummary[];
  } = {};
  const { dir, base } = pathLib.parse(entryFileName);
  const provenance = await extractProvenance(workspace, dir, base);
  const upgradeChanges: FixChangesSummary[] = [];
  const appliedUpgradeRemediation: string[] = [];
  /* Apply all upgrades first across all files that are included */
  for (const fileName of Object.keys(provenance)) {
    const skipApplyingPins = true;
    const { changes, appliedRemediation } = await fixIndividualRequirementsTxt(
      workspace,
      dir,
      base,
      fileName,
      remediation,
      provenance[fileName],
      options,
      skipApplyingPins,
    );
    appliedUpgradeRemediation.push(...appliedRemediation);
    upgradeChanges.push(...changes);
    fixedMeta[pathLib.normalize(pathLib.join(dir, fileName))] = upgradeChanges;
  }

  /* Apply all left over remediation as pins in the entry targetFile */
  const toPin: RemediationChanges = filterOutAppliedUpgrades(
    remediation,
    appliedUpgradeRemediation,
  );
  const directUpgradesOnly = false;
  const fileForPinning = await selectFileForPinning(entity);
  const { changes: pinnedChanges } = await fixIndividualRequirementsTxt(
    workspace,
    dir,
    base,
    fileForPinning.fileName,
    toPin,
    parseRequirementsFile(fileForPinning.fileContent),
    options,
    directUpgradesOnly,
  );

  return { changes: [...upgradeChanges, ...pinnedChanges], fixedMeta };
}

function filterOutAppliedUpgrades(
  remediation: RemediationChanges,
  appliedRemediation: string[],
): RemediationChanges {
  const pinRemediation: RemediationChanges = {
    ...remediation,
    pin: {}, // delete the pin remediation so we can collect un-applied remediation
  };
  const pins = remediation.pin;
  const normalizedAppliedRemediation = appliedRemediation.map(
    (packageAtVersion) => {
      const [pkgName, versionAndMore] = packageAtVersion.split('@');
      return `${standardizePackageName(pkgName)}@${versionAndMore}`;
    },
  );
  for (const pkgAtVersion of Object.keys(pins)) {
    const [pkgName, versionAndMore] = pkgAtVersion.split('@');
    if (
      !normalizedAppliedRemediation.includes(
        `${standardizePackageName(pkgName)}@${versionAndMore}`,
      )
    ) {
      pinRemediation.pin[pkgAtVersion] = pins[pkgAtVersion];
    }
  }
  return pinRemediation;
}

function sortByDirectory(
  entities: EntityToFix[],
): {
  [dir: string]: Array<{
    entity: EntityToFix;
    dir: string;
    base: string;
    ext: string;
    root: string;
    name: string;
  }>;
} {
  const mapped = entities.map((e) => ({
    entity: e,
    ...pathLib.parse(e.scanResult.identity.targetFile!),
  }));

  const sorted = sortBy(mapped, 'dir');
  return groupBy(sorted, 'dir');
}

export async function selectFileForPinning(
  entity: EntityToFix,
): Promise<{
  fileName: string;
  fileContent: string;
}> {
  const targetFile = entity.scanResult.identity.targetFile!;
  const { dir, base } = pathLib.parse(targetFile);
  const { workspace } = entity;
  // default to adding pins in the scanned file
  let fileName = base;
  let requirementsTxt = await workspace.readFile(targetFile);

  const { containsRequire, matches } = await containsRequireDirective(
    requirementsTxt,
  );
  const constraintsMatch = matches.filter((m) => m.includes('c'));
  if (containsRequire && constraintsMatch[0]) {
    // prefer to pin in constraints file if present
    fileName = constraintsMatch[0][2];
    requirementsTxt = await workspace.readFile(pathLib.join(dir, fileName));
  }
  return { fileContent: requirementsTxt, fileName };
}