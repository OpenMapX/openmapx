/** Real local Git repositories and actual paired-pin bootstrap, no upstream network. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ControlInstallation } from "@openmapx/core/build-artifacts";
import { initializeManagedCatalogPins, readCatalogPinSet } from "@openmapx/core/catalog-pins";
export async function installPinnedCredentialCatalog(root: string, installation: ControlInstallation) {
 const infraDir=join(root,"infra/docker"),catalog=join(infraDir,"data/.transitous-catalog"),atlas=join(catalog,"transitland-atlas");
 mkdirSync(join(catalog,"feeds"),{recursive:true});mkdirSync(join(atlas,"feeds"),{recursive:true});mkdirSync(join(root,"services/motis/tools/transitous"),{recursive:true});
 const git=(cwd:string,args:string[])=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{...process.env,GIT_AUTHOR_NAME:"fixture",GIT_AUTHOR_EMAIL:"fixture@example.test",GIT_COMMITTER_NAME:"fixture",GIT_COMMITTER_EMAIL:"fixture@example.test"}}).trim();
 git(atlas,["init"]);writeFileSync(join(atlas,"feeds/a.dmfr.json"),JSON.stringify({feeds:[{id:"auth",authorization:{type:"api-key"}}]}));git(atlas,["add","."]);git(atlas,["commit","-m","Atlas"]);const atlasSha=git(atlas,["rev-parse","HEAD"]);
 git(catalog,["init"]);writeFileSync(join(catalog,"feeds/de.json"),JSON.stringify({sources:[{name:"A","transitland-atlas-id":"auth"}]}));git(catalog,["add","feeds"]);git(catalog,["update-index","--add","--cacheinfo",`160000,${atlasSha},transitland-atlas`]);git(catalog,["commit","-m","Transitous"]);const sha=git(catalog,["rev-parse","HEAD"]);
 writeFileSync(join(infraDir,"transitous.lock.json"),JSON.stringify({ref:`main@${sha}`,submodules:{"transitland-atlas":atlasSha},lockedAt:"2026-10-23T00:00:00.000Z",lockedBy:"fixture"}));const gbfs="b".repeat(40);
 writeFileSync(join(infraDir,"gbfs-catalog.lock.json"),JSON.stringify({schemaVersion:1,source:"mobilitydata-gbfs",commit:gbfs,url:`https://raw.githubusercontent.com/MobilityData/gbfs/${gbfs}/systems.csv`,sha256:"c".repeat(64),lockedAt:"2026-10-23T00:00:00.000Z",lockedBy:"fixture"}));
 await initializeManagedCatalogPins({rootDir:root,installation});return readCatalogPinSet(root)!;
}
