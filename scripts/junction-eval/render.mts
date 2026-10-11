import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeExitPanel,
  parseLaneTags,
  selectApproachWay,
  selectRampWay,
} from "../../packages/core/src/navigation/laneTags.ts";
import type { LngLat } from "../../packages/core/src/types/geometry.ts";
import type {
  GantryModel,
  JunctionDecisionPoint,
  JunctionLookupResult,
} from "../../packages/core/src/types/junction.ts";
import type { Route, RouteStep } from "../../packages/core/src/types/routing.ts";
import type { StreetLevelImage } from "../../packages/core/src/types/streetLevel.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (key: string, fallback: string) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const source = resolve(
  repo,
  option("--cases", "plans/junction-implementation-2026-10-11/data/cases.json"),
);
const output = resolve(repo, option("--output", "scripts/junction-eval/results/browser"));
const require = createRequire(`${repo}/apps/web/package.json`);
const { build } = require("esbuild");
interface EvaluationCase {
  id: string;
  point: JunctionDecisionPoint;
  geometry: LngLat[];
  lookup?: JunctionLookupResult;
  gantry?: GantryModel;
  image?: StreetLevelImage;
  region: string;
  step?: RouteStep;
  route?: Route;
  assetError?: string;
  photo?: { status: string; image?: StreetLevelImage; objectUrl?: string };
}
interface BuildContext {
  onResolve(
    options: { filter: RegExp },
    handler: (args: { path: string }) => { path: string },
  ): void;
}
const cases = JSON.parse(readFileSync(source, "utf8")) as EvaluationCase[];
for (const c of cases) {
  const routeFile = resolve(source, "..", `${c.region}-route.json`);
  if (existsSync(routeFile)) {
    c.route = JSON.parse(readFileSync(routeFile, "utf8")).body.routes[0];
    c.step = c.route?.steps[c.point.stepIndex];
  }
  if (!c.lookup) continue;
  const lookup = c.lookup;
  const approach =
    lookup.outgoingApproachWayId !== undefined
      ? lookup.approach.find((way) => way.wayId === lookup.outgoingApproachWayId)
      : (selectApproachWay(lookup.approach, c.point) ?? undefined);
  const model = approach ? parseLaneTags(approach.tags, c.point.laneCount) : null;
  c.gantry = model
    ? {
        ...mergeExitPanel(model, c.point, selectRampWay(lookup.ramps, c.point)[0]?.tags, {
          ways: lookup.outgoing ?? [],
          approach,
        }),
        approachWays: lookup.approach,
      }
    : undefined;
}
mkdirSync(`${output}/assets`, { recursive: true });
for (const c of cases) {
  if (!c.image) {
    c.photo = { status: "none" };
    continue;
  }
  const asset = c.image.isPano ? c.image.assets.sd : (c.image.assets.thumb ?? c.image.assets.sd);
  const target = `${output}/assets/${c.image.id}.jpg`;
  if (!existsSync(target) && asset) {
    try {
      const res = await fetch(asset, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 8_000_000) throw new Error("asset-too-large");
      writeFileSync(target, bytes);
    } catch (error) {
      c.assetError = String(error);
    }
  }
  c.photo = existsSync(target)
    ? { status: "ready", image: c.image, objectUrl: `/assets/${c.image.id}.jpg` }
    : { status: "none" };
}
writeFileSync(`${output}/cases.json`, JSON.stringify(cases));
writeFileSync(
  `${output}/runtime.ts`,
  `export { signHeadline, visibleToward, cleanSignTexts, exitNumberLabel, refKind } from '${repo}/packages/core/src/navigation/signFormat.ts'; export {formatMeasurementDistance} from '${repo}/packages/core/src/utils/formatting.ts'; export {resolveRecommendedLanes} from '${repo}/packages/core/src/navigation/lanes.ts';`,
);
const messages = Object.fromEntries(
  ["en", "de"].map((locale) => [
    locale,
    JSON.parse(readFileSync(`${repo}/packages/i18n/locales/${locale}.json`, "utf8")).navigation,
  ]),
);
const viewer = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl'; import { ThemeProvider, createTheme } from '@mui/material/styles';
import { ManeuverBanner } from '${repo}/apps/web/src/components/navigation/ManeuverBanner.tsx';
import { processFix } from '${repo}/packages/core/src/navigation/processFix.ts';
import { positionAt,cumulativeDistances } from '${repo}/packages/core/src/navigation/deadReckon.ts';
import { navOptionsForMode } from '${repo}/packages/core/src/navigation/options.ts';
import { upcomingManeuverIndex } from '${repo}/packages/core/src/navigation/progress.ts';
import { guidanceApproachMeters,junctionPhotoApproachMeters } from '${repo}/packages/core/src/navigation/lanes.ts';
import { JunctionViewPanel } from '${repo}/apps/web/src/components/navigation/junction/JunctionViewPanel.tsx';
import { prepareJunctionPhoto, photoPreparationKey } from '${repo}/apps/web/src/lib/navigation/prepareJunctionPhoto.ts';
const cases = await (await fetch('/cases.json')).json(); window.__cases = cases; window.__outcomes = {};
const root = createRoot(document.getElementById('capture')); const messages = ${JSON.stringify(messages)};
window.prepare = async (id) => {
 const c = cases.find(c => c.id === id); if (!c.photo?.objectUrl || c.photo.prepared) return;
 let diagnostic; const controller = new AbortController(); const prepared = await prepareJunctionPhoto(c.photo.objectUrl, c.geometry, c.point, c.image, c.gantry, photoPreparationKey(1,c.point,c.image,c.gantry), controller.signal, d=>{ diagnostic=d; });
 window.__outcomes[id] = prepared ? { prepared:true, ms:prepared.preparationMs, width:prepared.width, height:prepared.height, registration:prepared.registration, visible:prepared.path.visible, path:prepared.path } : { prepared:false, diagnostic };
 c.photo = prepared ? { ...c.photo, prepared } : { status:'none' };
};
window.showCases = (ids, width=390, locale='en', dark=false, distance=300, speed=27) => root.render(<ThemeProvider theme={createTheme({palette:{mode:dark?'dark':'light'}})}><NextIntlClientProvider locale={locale} timeZone="UTC" messages={{navigation:messages[locale]}}><div style={{display:'flex',gap:16,alignItems:'flex-start',flexWrap:'wrap'}}>{ids.map(id=>{const c=cases.find(c=>c.id===id);return <section key={id} style={{width,padding:12,boxSizing:'border-box',background:dark?'#121212':'#edf1f5',color:dark?'white':'#111',borderRadius:16}}><h2 style={{fontSize:14,margin:'0 0 8px'}}>{id}</h2><ManeuverBanner instruction={c.step?.instruction ?? 'Continue'} distanceToManeuver={distance} maneuver={c.step?.maneuver} lanes={distance<=guidanceApproachMeters('driving',speed) ? (c.gantry?.laneGuidance?.lanes ?? c.point.laneGuidance?.lanes) : undefined} sign={c.point.sign} country="DE" units="metric"/><div className="view" style={{marginTop:12}}><JunctionViewPanel point={c.point} gantry={c.gantry} photo={distance<=junctionPhotoApproachMeters('driving',speed)?c.photo:undefined} geometry={c.geometry}/></div></section>})}</div></NextIntlClientProvider></ThemeProvider>);
window.navigationReplay=async(id)=> {
 const c=cases.find(c=>c.id===id);if(!c.route)return {id,untested:'missing-route'};
 let state={offRouteScore:0,lastRerouteAtMs:null,rerouteBackoffMs:0,spokenCues:[],committedStepIndex:c.point.stepIndex-1};const outcomes=[];const cum=cumulativeDistances(c.geometry);
 for(const [index,distance] of [1500,1000,500,300,100,30,0,-50].entries()) {
  const at=positionAt(c.geometry,cum,c.point.alongMeters-distance);const result=processFix(c.route,{coords:at.point,accuracy:3,speed:27,heading:at.bearing,timestampMs:index*1000},state,navOptionsForMode('driving'));state=result.nextState;
  const upcoming=upcomingManeuverIndex(result.progress?.currentStepIndex??0,c.route.steps.length);const visible=upcoming===c.point.stepIndex;
  window.showCases([id],390,'en',false,visible?result.progress.distanceToNextManeuver:Infinity); await new Promise(r=>setTimeout(r,80));
  outcomes.push({distance,upcoming,actualDistance:result.progress?.distanceToNextManeuver,needsReroute:result.needsReroute,photo:document.querySelectorAll('[data-testid=junction-photo]').length,visible});
 }
 return {id,steps:outcomes};
};
window.replay = async () => { for(const c of cases) { await window.prepare(c.id); window.showCases([c.id]); await new Promise(r=>setTimeout(r,80)); const view=document.querySelector('.view'); window.__outcomes[c.id]={...window.__outcomes[c.id],id:c.id,polygons:view?.querySelectorAll('[data-photo-path] polygon').length || 0,panels:[...view?.querySelectorAll('[data-panel]')||[]].map(p=>({text:p.innerText,active:p.getAttribute('data-active')})),label:view?.querySelector('[role=img]')?.getAttribute('aria-label')}; } return window.__outcomes; };
window.showCases(cases.slice(0,3).map(c=>c.id)); window.__ready=true;
const params=new URLSearchParams(location.search); if(params.has('replay')) {
 const started=performance.now(); const longTasks=[]; const longTasksSupported=typeof PerformanceObserver!=='undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask'); if(longTasksSupported) {new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});}
 await window.replay(); const measured=Object.values(window.__outcomes).filter(o=>o.ms!==undefined).map(o=>o.ms).sort((a,b)=>a-b);
 const report={photos:Object.values(window.__outcomes).filter(o=>o.prepared!==undefined).length,prepared:measured.length,overlays:Object.values(window.__outcomes).filter(o=>o.visible).length,p95AcceptedPreparationMs:measured[Math.ceil(measured.length*.95)-1] ?? null,replayMs:performance.now()-started,longTasksSupported,longTasks:longTasksSupported?longTasks.length:null,longestTaskMs:longTasksSupported?Math.max(0,...longTasks):null,userAgent:navigator.userAgent};
 const pre=document.createElement('pre');pre.id='device-report';pre.style='white-space:pre-wrap;font-size:14px';pre.textContent=JSON.stringify(report,null,2);document.body.append(pre);
 window.showCases([cases.find(c=>c.photo.prepared)?.id ?? cases[0].id],Math.min(390,innerWidth-32),params.get('locale')??'en',params.get('dark')==='1');
} else if(params.has('case')) { const id=params.get('case');await window.prepare(id);window.showCases([id],Math.min(390,innerWidth-32),params.get('locale')??'en',params.get('dark')==='1'); }

`;
mkdirSync(`${output}/src/lib/navigation`, { recursive: true });
mkdirSync(`${output}/src/generated`, { recursive: true });
const alias = {
  name: "evaluation-runtime",
  setup(b: BuildContext) {
    b.onResolve({ filter: /^@openmapx\/core$/ }, () => ({ path: `${output}/runtime.ts` }));
    b.onResolve({ filter: /^@openmapx\/core\/navigation\/photo$/ }, () => ({
      path: `${repo}/packages/core/src/navigation/photo.ts`,
    }));
    b.onResolve(
      { filter: /^(react(?:\/.*)?|react-dom(?:\/.*)?|@mui\/.*|next-intl)$/ },
      (a: { path: string }) => ({ path: require.resolve(a.path) }),
    );
  },
};
await build({
  stdin: {
    contents: viewer,
    resolveDir: `${repo}/apps/web`,
    loader: "tsx",
    sourcefile: "junction-evaluation.tsx",
  },
  outfile: `${output}/src/lib/navigation/viewer.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [alias],
});
await build({
  entryPoints: [`${repo}/apps/web/src/components/navigation/junction/photoAlignment.worker.ts`],
  outfile: `${output}/src/generated/photoAlignment.worker.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  plugins: [alias],
});
writeFileSync(
  `${output}/index.html`,
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${readFileSync(`${repo}/apps/web/src/app/reset.css`, "utf8")}body{font-family:system-ui;margin:16px}</style></head><body><main id="capture"></main><script type="module" src="/src/lib/navigation/viewer.js"></script></body></html>`,
);
console.log(
  JSON.stringify({
    cases: cases.length,
    downloaded: cases.filter((c) => c.photo?.objectUrl).length,
    failures: cases.filter((c) => c.assetError).length,
    output,
  }),
);
