/** `libscope config show|get|set|unset|path`. */
import type { Command } from "commander";
import {
  CONFIG_KEY_NAMES,
  getConfigFileFor,
  getConfigValue,
  getSecretsPath,
  getUserConfigPath,
  loadConfig,
  maskConfigSecrets,
  maskSecret,
  setUserConfigValue,
  unsetUserConfigValue,
} from "../../config.js";
import { print } from "../run.js";

export function register(program: Command): void {
  const config = program
    .command("config")
    .description(`Show and change settings (user file: ${getUserConfigPath()})`);

  config
    .command("show")
    .description("Show the effective configuration (API keys are masked)")
    .action(() => {
      console.log(JSON.stringify(maskConfigSecrets(loadConfig()), null, 2));
    });

  config
    .command("get <key>")
    .description("Print the effective value of a key (API keys are masked)")
    .action((key: string) => {
      const value = getConfigValue(loadConfig(), key);
      print({ key, value: value ?? null }, (r) =>
        console.log(r.value === null ? "" : String(r.value)),
      );
    });

  config
    .command("set <key> <value>")
    .description(
      `Set a key in the user config file. Keys: ${CONFIG_KEY_NAMES.join(", ")}. ` +
        `API keys are written to ${getSecretsPath()} (mode 0600), never to config.json.`,
    )
    .action((key: string, value: string) => {
      const stored = setUserConfigValue(key, value);
      const file = getConfigFileFor(key);
      const shown = file === getSecretsPath() ? maskSecret(String(stored)) : String(stored);
      console.log(`✓ ${key} set to: ${shown} (${file})`);
    });

  config
    .command("unset <key>")
    .description("Remove a key from the user config file (or secrets file for API keys)")
    .action((key: string) => {
      const removed = unsetUserConfigValue(key);
      console.log(removed ? `✓ ${key} removed` : `${key} is not set in ${getConfigFileFor(key)}`);
    });

  config
    .command("path")
    .description("Print the path of the user config file")
    .action(() => {
      console.log(getUserConfigPath());
    });
}
