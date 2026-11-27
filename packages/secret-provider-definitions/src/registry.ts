import { makeSecretProviderDefinitionRegistry } from "@zerocode/secret-provider-core/shared/definition";
import * as OnePassword from "@zerocode/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
