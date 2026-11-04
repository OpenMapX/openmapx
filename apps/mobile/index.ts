import "./src/platform/installCrypto";
import "./src/platform/installAbortSignal";
import "./src/background/defineNavigationTask";
import "./src/car/carRuntime";
import { registerRootComponent } from "expo";
import { App } from "./src/App";

registerRootComponent(App);
