/**
 * Opens a price-aware model picker. Prices come from Pi's model catalog and are
 * displayed in USD per million tokens.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, Spacer, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";

type SortMode = "name" | "price";

type PickerModel = {
  id: string;
  name: string;
  provider: string;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: readonly unknown[];
  };
};

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
});

function formatRate(rate: number | undefined): string {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return "n/a";
  return usdFormatter.format(rate);
}

function modelKey(provider: string, id: string): string {
  return `${provider}\0${id}`;
}

function compareRate(a: number | undefined, b: number | undefined): number {
  const left = typeof a === "number" && Number.isFinite(a) && a >= 0 ? a : Number.POSITIVE_INFINITY;
  const right = typeof b === "number" && Number.isFinite(b) && b >= 0 ? b : Number.POSITIVE_INFINITY;
  return left === right ? 0 : left < right ? -1 : 1;
}

function displayName(model: PickerModel): string {
  return model.name.trim() || model.id;
}

function sortModels<T extends PickerModel>(models: readonly T[], sortBy: SortMode): T[] {
  return [...models].sort((a, b) => {
    if (sortBy === "price") {
      const priceComparison =
        compareRate(a.cost.input, b.cost.input) ||
        compareRate(a.cost.output, b.cost.output) ||
        compareRate(a.cost.cacheRead, b.cost.cacheRead) ||
        compareRate(a.cost.cacheWrite, b.cost.cacheWrite);
      if (priceComparison !== 0) return priceComparison;
    } else {
      const nameComparison = displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" });
      if (nameComparison !== 0) return nameComparison;
    }
    return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
  });
}

function priceSummary(model: PickerModel): string {
  return [
    `In ${formatRate(model.cost.input)}`,
    `Out ${formatRate(model.cost.output)}`,
    `Cache read ${formatRate(model.cost.cacheRead)}`,
    `Cache write ${formatRate(model.cost.cacheWrite)}`,
  ].join(" · ");
}

function tierNote(model: PickerModel): string {
  const count = model.cost.tiers?.length ?? 0;
  return count > 0 ? ` · ${count} pricing tier${count === 1 ? "" : "s"}` : "";
}

function sortLabel(sortBy: SortMode): string {
  return sortBy === "price" ? "Base input price: low → high" : "Name A–Z";
}

export default function modelPrices(pi: ExtensionAPI): void {
  pi.registerCommand("model-prices", {
    description: "Select a model with token prices; press s in the TUI to toggle sort",
    handler: async (args, ctx) => {
      const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const sortTokens = tokens.filter((token) => token === "name" || token === "price");
      const invalidTokens = tokens.filter((token) => token !== "all" && token !== "name" && token !== "price");
      if (sortTokens.length > 1 || invalidTokens.length > 0) {
        ctx.ui.notify("Usage: /model-prices [name|price] [all]", "warning");
        return;
      }

      const initialSort: SortMode = sortTokens.includes("price") ? "price" : "name";
      const includeAllModels = tokens.includes("all");
      const availableModels = [...ctx.modelRegistry.getAvailable()];
      const scopedKeys = new Set(ctx.scopedModels.map(({ model }) => modelKey(model.provider, model.id)));
      const models =
        includeAllModels || scopedKeys.size === 0
          ? availableModels
          : availableModels.filter((model) => scopedKeys.has(modelKey(model.provider, model.id)));

      if (models.length === 0) {
        ctx.ui.notify("No available models found. Configure a provider with /login first.", "warning");
        return;
      }

      const modelByKey = new Map<string, (typeof models)[number]>();
      for (const model of models) {
        modelByKey.set(modelKey(model.provider, model.id), model);
      }
      const currentKey = ctx.model ? modelKey(ctx.model.provider, ctx.model.id) : undefined;
      let selectedModelKey: string | undefined;

      if (ctx.mode === "tui") {
        selectedModelKey = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
          const container = new Container();
          let sortBy = initialSort;
          let selectList: SelectList | undefined;
          let detailsText: Text | undefined;

          const updateDetails = (key: string | undefined) => {
            if (!detailsText) return;
            const model = key ? modelByKey.get(key) : undefined;
            detailsText.setText(
              model
                ? `${displayName(model)} · ${model.provider}/${model.id}\nUSD per 1M tokens: ${priceSummary(model)}${tierNote(model)}`
                : "",
            );
          };

          const rebuild = (preferredKey?: string) => {
            const sorted = sortModels(models, sortBy);
            const items = sorted.map((model) => ({
              value: modelKey(model.provider, model.id),
              label: displayName(model),
              description: `${priceSummary(model)} · ${model.provider}/${model.id}${tierNote(model)}`,
            }));

            const list = new SelectList(
              items,
              Math.min(items.length, 10),
              {
                selectedPrefix: (text) => theme.fg("accent", text),
                selectedText: (text) => theme.fg("accent", text),
                description: (text) => theme.fg("muted", text),
                scrollInfo: (text) => theme.fg("dim", text),
                noMatch: (text) => theme.fg("warning", text),
              },
              { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 36 },
            );
            list.onSelect = (item) => done(item.value);
            list.onCancel = () => done(undefined);
            list.onSelectionChange = (item) => {
              updateDetails(item.value);
              tui.requestRender();
            };
            const preferredIndex = preferredKey ? items.findIndex((item) => item.value === preferredKey) : -1;
            if (preferredIndex >= 0) list.setSelectedIndex(preferredIndex);
            selectList = list;

            const details = new Text("");
            detailsText = details;
            updateDetails(list.getSelectedItem()?.value);

            container.clear();
            container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("accent", theme.bold("Select model")), 1, 0));
            container.addChild(
              new Text(
                `${theme.fg("muted", "Sort: ")}${theme.fg("accent", sortLabel(sortBy))}${theme.fg("dim", " · press s to toggle")}`,
                1,
                0,
              ),
            );
            container.addChild(new Text(theme.fg("dim", "Prices in USD per 1M tokens"), 1, 0));
            container.addChild(new Spacer(1));
            container.addChild(list);
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("muted", "Selected model"), 1, 0));
            container.addChild(details);
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel · s toggle sort"), 1, 0),
            );
            container.addChild(new Spacer(1));
            container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
          };

          rebuild(currentKey);

          return {
            render(width: number) {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              const list = selectList;
              if (!list) return;
              if (matchesKey(data, "s") || matchesKey(data, "shift+s")) {
                const preferredKey = list.getSelectedItem()?.value;
                sortBy = sortBy === "name" ? "price" : "name";
                rebuild(preferredKey);
              } else {
                list.handleInput(data);
              }
              tui.requestRender();
            },
            handleMouse(event: TuiMouseEvent) {
              return container.handleMouse(event);
            },
          };
        });
      } else {
        const sorted = sortModels(models, initialSort);
        const labels = new Map<string, string>();
        const options = sorted.map((model) => {
          const key = modelKey(model.provider, model.id);
          const label = `${priceSummary(model)} · ${displayName(model)} [${model.provider}/${model.id}]${tierNote(model)}`;
          labels.set(label, key);
          return label;
        });
        const sortDescription = initialSort === "price" ? "base input price, lowest first" : "name, A–Z";
        const selectedLabel = await ctx.ui.select(
          `Select model · sorted by ${sortDescription} · USD per 1M tokens`,
          options,
        );
        selectedModelKey = selectedLabel ? labels.get(selectedLabel) : undefined;
      }

      const selectedModel = selectedModelKey ? modelByKey.get(selectedModelKey) : undefined;
      if (!selectedModel) return;

      try {
        const selected = await pi.setModel(selectedModel);
        if (selected) {
          ctx.ui.notify(`Model: ${selectedModel.provider}/${selectedModel.id}`, "info");
        } else {
          ctx.ui.notify(
            `Could not select ${selectedModel.provider}/${selectedModel.id}; check provider credentials.`,
            "warning",
          );
        }
      } catch (error) {
        ctx.ui.notify(`Could not select model: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
