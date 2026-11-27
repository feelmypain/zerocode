import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  type ServerProvider,
} from "@zerocode/contracts";
import { UnifiedSettings } from "@zerocode/contracts/settings";
import {
  createModelSelection,
  normalizeCustomModelSlug,
  normalizeModelSlug,
} from "@zerocode/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DeepMutable } from "effect/Types";
import { draftModelSelectionApplies } from "../lib/chatThreadActions";
import {
  readInstanceCustomModels,
  resolveAppModelSelection,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import { getDefaultServerModel } from "../providerModels";
import {
  type ComposerDraftStoreState,
  type ComposerThreadDraftState,
  type EffectiveComposerModelState,
  isProviderDriverKind,
  type LegacyCodexFields,
  type PersistedComposerDraftStoreState,
  type ProviderOptionSelectionsByProvider,
} from "./types";

function selectionsByInstance(
  modelSelection: ModelSelection | null | undefined,
): Partial<Record<string, ModelSelection>> | null {
  return modelSelection ? { [modelSelection.instanceId]: modelSelection } : null;
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function cloneModelSelection(selection: ModelSelection): DeepMutable<ModelSelection> {
  return {
    ...selection,
    ...(selection.options ? { options: selection.options.map((option) => ({ ...option })) } : {}),
  } as DeepMutable<ModelSelection>;
}

export function compactModelSelectionByProvider(
  selections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): DeepMutable<Record<ProviderInstanceId, ModelSelection>> {
  const entries: Array<[string, DeepMutable<ModelSelection>]> = [];
  for (const [provider, selection] of Object.entries(selections)) {
    if (selection !== undefined) {
      entries.push([provider, cloneModelSelection(selection)]);
    }
  }
  return Object.fromEntries(entries) as DeepMutable<Record<ProviderInstanceId, ModelSelection>>;
}

export function compactStickyOptionsByModel(
  optionsByModelByProvider: ComposerDraftStoreState["stickyOptionsByModelByProvider"],
): NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]> {
  const result: Record<string, Record<string, ReadonlyArray<ProviderOptionSelection>>> = {};
  for (const [instanceId, optionsByModel] of Object.entries(optionsByModelByProvider)) {
    for (const [modelSlug, options] of Object.entries(optionsByModel ?? {})) {
      if (options === undefined || options.length === 0) continue;
      result[instanceId] ??= {};
      result[instanceId][modelSlug] = options;
    }
  }
  return result as NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]>;
}

export function seedStickyOptionsByModel(
  stickySelections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]> {
  const result: Record<string, Record<string, ReadonlyArray<ProviderOptionSelection>>> = {};
  for (const [instanceId, selection] of Object.entries(stickySelections)) {
    if (
      selection === undefined ||
      selection.options === undefined ||
      selection.options.length === 0
    ) {
      continue;
    }
    result[instanceId] = { [selection.model]: selection.options };
  }
  return result as NonNullable<PersistedComposerDraftStoreState["stickyOptionsByModelByProvider"]>;
}

export function normalizeProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return isProviderDriverKind(value) ? value : null;
}

/** The schema owns validation; this permissive pattern keeps Effect Schema off the hot path. */
const PROVIDER_INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function normalizeProviderInstanceId(value: unknown): ProviderInstanceId | null {
  if (typeof value !== "string") return null;
  if (!PROVIDER_INSTANCE_ID_PATTERN.test(value)) return null;
  return value as ProviderInstanceId;
}

function coerceProviderOptionSelections(
  value: unknown,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (Array.isArray(value)) {
    const out: ProviderOptionSelection[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const optionValue = record.value;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof optionValue === "string" || typeof optionValue === "boolean") {
        out.push({ id, value: optionValue });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: ProviderOptionSelection[] = [];
    for (const [id, raw] of Object.entries(record)) {
      if (typeof raw === "string" || typeof raw === "boolean") {
        out.push({ id, value: raw });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

export function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderDriverKind | null,
  legacy?: LegacyCodexFields,
): ProviderOptionSelectionsByProvider | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const providerKey of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
    const selections = coerceProviderOptionSelections(candidate?.[providerKey]);
    if (selections) {
      result[providerKey] = selections;
    }
  }

  if (provider === "codex" && legacy) {
    const codexExtras: ProviderOptionSelection[] = [];
    if (typeof legacy.effort === "string" && legacy.effort.length > 0) {
      codexExtras.push({ id: "reasoningEffort", value: legacy.effort });
    }
    const fastMode =
      legacy.codexFastMode === true ||
      (typeof legacy.serviceTier === "string" && legacy.serviceTier === "fast");
    if (fastMode) {
      codexExtras.push({ id: "fastMode", value: true });
    }
    if (codexExtras.length > 0) {
      const existing = result.codex ?? [];
      const existingIds = new Set(existing.map((entry) => entry.id));
      const merged = [...existing];
      for (const extra of codexExtras) {
        if (!existingIds.has(extra.id)) merged.push(extra);
      }
      result.codex = merged;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

type NormalizedModelSelection = Omit<ModelSelection, "instanceId"> & {
  readonly instanceId: ProviderInstanceId;
};

export function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): NormalizedModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const instanceId = normalizeProviderInstanceId(
    candidate?.instanceId ?? candidate?.provider ?? legacy?.provider,
  );
  if (instanceId === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  const driverKindHint =
    normalizeProviderDriverKind(candidate?.provider ?? legacy?.provider) ??
    ProviderDriverKind.make("codex");
  // Instance-scoped picks are already resolved slugs; a custom slug can match a static alias.
  const model =
    candidate?.instanceId === undefined
      ? normalizeModelSlug(rawModel, driverKindHint)
      : normalizeCustomModelSlug(rawModel);
  if (!model) {
    return null;
  }
  if (Array.isArray(candidate?.options)) {
    const selections = coerceProviderOptionSelections(candidate.options);
    return createModelSelection(instanceId, model, selections) as NormalizedModelSelection;
  }
  const kindForLegacyOptions = normalizeProviderDriverKind(instanceId);
  const modelOptions = kindForLegacyOptions
    ? normalizeProviderModelOptions(
        candidate?.options ? { [kindForLegacyOptions]: candidate.options } : legacy?.modelOptions,
        kindForLegacyOptions,
        kindForLegacyOptions === "codex" ? legacy?.legacyCodex : undefined,
      )
    : null;
  const options = kindForLegacyOptions ? modelOptions?.[kindForLegacyOptions] : undefined;
  return createModelSelection(instanceId, model, options) as NormalizedModelSelection;
}

export function legacySyncModelSelectionOptions(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): NormalizedModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  const options = kind ? modelOptions?.[kind] : undefined;
  return createModelSelection(
    modelSelection.instanceId,
    modelSelection.model,
    options,
  ) as NormalizedModelSelection;
}

function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
  provider: ProviderDriverKind,
  nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const merged: ProviderOptionSelectionsByProvider = { ...otherProviderModelOptions };
  if (nextProviderOptions && nextProviderOptions.length > 0) {
    merged[provider] = nextProviderOptions;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

export function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: NormalizedModelSelection | null,
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection?.options || modelSelection.options.length === 0) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  if (!kind) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    kind,
    modelSelection.options,
  );
}

export function legacyToModelSelectionByProvider(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  const result: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent", "cursor", "opencode"] as const) {
      const options = modelOptions[provider];
      if (options && options.length > 0) {
        const driverKind = ProviderDriverKind.make(provider);
        const instanceKey = defaultInstanceIdForDriver(driverKind);
        result[instanceKey] = createModelSelection(
          instanceKey,
          modelSelection?.instanceId === instanceKey
            ? modelSelection.model
            : (DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL),
          options,
        );
      }
    }
  }
  if (modelSelection) {
    result[modelSelection.instanceId] = modelSelection as ModelSelection;
  }
  return result;
}

const decodePersistedModelSelection = Schema.decodeUnknownOption(ModelSelection);

/** Storage v3-v5 wrote `provider` and object-shaped options; the schema upgrades both. */
export function normalizePersistedModelSelectionByProvider(
  value: object,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([instanceId, selection]) =>
      Option.match(decodePersistedModelSelection(selection), {
        onNone: () => [],
        onSome: (decoded) => [[instanceId, decoded] as const],
      }),
    ),
  );
}

// Static aliases are shared across instances; exact custom slugs and catalog aliases are not.
function composerModelIdentity(
  input: {
    providers: ReadonlyArray<ServerProvider>;
    settings: UnifiedSettings;
    selectedProvider: ProviderDriverKind;
  },
  instanceId: ProviderInstanceId,
  model: string | undefined,
) {
  const isCustom =
    input.providers
      .find((provider) => provider.instanceId === instanceId)
      ?.models.some((entry) => entry.slug === model && entry.isCustom) ||
    readInstanceCustomModels(input.settings, instanceId, input.selectedProvider).some(
      (entry) => entry.slug === model,
    );
  return isCustom ? model : normalizeModelSlug(model, input.selectedProvider);
}

interface InstanceModel {
  readonly instanceId: ProviderInstanceId;
  readonly model: string | undefined;
}

export function isSameModel(
  input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly selectedProvider: ProviderDriverKind;
    readonly settings: UnifiedSettings;
  },
  a: InstanceModel,
  b: InstanceModel,
): boolean {
  return (
    a.model === b.model ||
    composerModelIdentity(input, a.instanceId, a.model) ===
      composerModelIdentity(input, b.instanceId, b.model)
  );
}

/**
 * When the requested instance is disabled or unavailable, the composer shows another instance of
 * the same driver. When that instance has no options of its own and shows the model the requested
 * instance's options were picked with, it takes those options instead of the model's defaults.
 */
function withFallbackInstanceOptions(input: {
  readonly modelOptions: ProviderOptionSelectionsByProvider | null;
  readonly optionSelections: Partial<Record<string, ModelSelection>> | null;
  readonly selectedModel: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedInstanceId?: ProviderInstanceId | null | undefined;
  readonly requestedInstanceId?: ProviderInstanceId | null | undefined;
  readonly settings: UnifiedSettings;
}): ProviderOptionSelectionsByProvider | null {
  const { modelOptions, selectedInstanceId, requestedInstanceId } = input;
  if (
    !modelOptions ||
    !selectedInstanceId ||
    !requestedInstanceId ||
    selectedInstanceId === requestedInstanceId ||
    modelOptions[selectedInstanceId] !== undefined
  ) {
    return modelOptions;
  }
  const requestedOptions = modelOptions[requestedInstanceId];
  const requestedProvider = input.providers.find(
    (provider) => provider.instanceId === requestedInstanceId,
  );
  const sameModel = isSameModel(
    input,
    {
      instanceId: requestedInstanceId,
      model: input.optionSelections?.[requestedInstanceId]?.model,
    },
    { instanceId: selectedInstanceId, model: input.selectedModel },
  );
  if (!requestedOptions || requestedProvider?.driver !== input.selectedProvider || !sameModel) {
    return modelOptions;
  }
  return { ...modelOptions, [selectedInstanceId]: requestedOptions };
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<
        ComposerThreadDraftState,
        "modelSelectionByProvider" | "activeProvider" | "modelSelectionExplicit"
      >
    | null
    | undefined;
  threadStarted: boolean;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  /** The instance the draft, thread or project asked for; differs from the selection on fallback. */
  requestedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = draftModelSelectionApplies(input.draft, input.threadStarted) ? input.draft : null;
  const baseSelection = input.threadModelSelection ?? input.projectModelSelection;
  const baseModelCandidate = baseSelection?.model ?? null;
  const preserveThreadModel =
    input.selectedInstanceId !== null &&
    input.selectedInstanceId !== undefined &&
    input.threadModelSelection?.instanceId === input.selectedInstanceId;
  const baseModel =
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
          { preserveUnavailableSelection: preserveThreadModel },
        )
      : null) ??
    // Antigravity has no static model or cross-account catalog fallback.
    (input.selectedProvider === "antigravity" && input.selectedInstanceId ? "" : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider);
  const instanceSelection = input.selectedInstanceId
    ? draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  // Legacy driver-keyed drafts belong to the default instance.
  const legacySelection =
    input.selectedInstanceId &&
    input.selectedInstanceId !== defaultInstanceIdForDriver(input.selectedProvider)
      ? undefined
      : draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);
  const selectedModel = activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
        { preserveUnavailableSelection: true },
      ) ??
      (input.selectedProvider === "antigravity" ? "" : null) ??
      resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      ))
    : baseModel;
  // Base options belong to the base model, so a draft pick of another model gets none of them.
  const draftPicksOtherModel =
    !!activeSelection?.model &&
    composerModelIdentity(input, activeSelectionInstanceId, activeSelection.model) !==
      composerModelIdentity(
        input,
        baseSelection?.instanceId ?? activeSelectionInstanceId,
        baseSelection?.model,
      );
  // An existing thread's options, even none, outrank the project's. Next to draft options, they
  // fill in only for the model they were stored with. Each source keeps its selections so a
  // fallback instance can check which model its options belong to.
  const optionsFrom = (optionSelections: Partial<Record<string, ModelSelection>> | null) =>
    withFallbackInstanceOptions({
      ...input,
      modelOptions: modelSelectionByProviderToOptions(optionSelections),
      optionSelections,
      selectedModel,
    });
  const draftOptions = optionsFrom(draft?.modelSelectionByProvider ?? null);
  const storedIsShownModel =
    baseSelection != null &&
    isSameModel(input, baseSelection, {
      instanceId: input.selectedInstanceId ?? baseSelection.instanceId,
      model: selectedModel,
    });
  const storedOptions = optionsFrom(
    !draftPicksOtherModel && (draftOptions === null || storedIsShownModel)
      ? selectionsByInstance(baseSelection)
      : null,
  );

  return {
    selectedModel,
    modelOptions: draftOptions || storedOptions ? { ...storedOptions, ...draftOptions } : null,
  };
}
