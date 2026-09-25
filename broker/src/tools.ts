import type { BrokerConfig } from "./config"
import type { ToolDef } from "./mcp"
import { buildEnvTools } from "./tools-env"
import { buildFsTools } from "./tools-fs"
import { buildRunTools } from "./tools-run"
import type { Bindings } from "./tools-shared"

export type { Bindings } from "./tools-shared"

/**
 * The tool list, in the order the model sees it in tools/list: environment
 * lifecycle first, then execution, then files. Files come last because they are
 * useless without an environment, and tools/list order is one of the few cheap
 * hints we get to give about sequencing.
 */
export function buildTools(env: Bindings, cfg: BrokerConfig): ToolDef[] {
	return [...buildEnvTools(env, cfg), ...buildRunTools(env, cfg), ...buildFsTools(env, cfg)]
}
