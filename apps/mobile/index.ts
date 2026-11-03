import "./src/platform/installCrypto";
import "./src/background/defineNavigationTask";
import { registerRootComponent } from "expo";
import { App } from "./src/App";

registerRootComponent(App);
