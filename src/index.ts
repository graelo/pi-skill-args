import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerArgsHandler } from "./args.js";

export default function (pi: ExtensionAPI): void {
  registerArgsHandler(pi);
}
