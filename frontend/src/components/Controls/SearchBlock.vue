<template>
	<div class="flex flex-col gap-2">
		<!-- the toolbar takes the popup header's place, so the panel has no title row;
		mousedown is stopped on the controls so pressing them doesn't drag the popup -->
		<Teleport :to="headerTarget" :disabled="!headerTarget">
			<div class="-ml-1 flex items-center justify-between gap-2">
				<TabButtons v-if="canReplace" v-model="mode" :options="modeOptions" @mousedown.stop />
				<div class="ml-auto flex items-center gap-0.5" @mousedown.stop>
					<Tooltip :text="__('Search in selected blocks')">
						<button
							type="button"
							:class="toolClass(isSelectionScope)"
							:disabled="!canSearchSelection"
							:aria-pressed="isSelectionScope"
							@click="setScope(isSelectionScope ? 'page' : 'selection')">
							<span class="lucide-square-dashed-mouse-pointer size-3.5" aria-hidden="true" />
						</button>
					</Tooltip>
					<Popover side="bottom" align="end" :offset="6">
						<template #trigger>
							<button type="button" :class="toolClass(isFiltered)" :aria-label="__('Search in')">
								<span class="lucide-list-filter size-3.5" aria-hidden="true" />
							</button>
						</template>
						<template #default>
							<div class="w-40 p-1">
								<div class="px-2 pb-1 pt-1 text-xs text-ink-gray-5">{{ __("Search in") }}</div>
								<Checkbox
									v-for="{ domain, label } in domains"
									:key="domain"
									padded
									size="sm"
									:label="label"
									:modelValue="activeDomains.includes(domain)"
									:disabled="activeDomains.length === 1 && activeDomains.includes(domain)"
									@update:modelValue="toggleDomain(domain)" />
							</div>
						</template>
					</Popover>
				</div>
			</div>
		</Teleport>

		<BuilderInput
			ref="findInput"
			:placeholder="isReplaceMode ? __('Find') : __('Search blocks')"
			:modelValue="findText"
			@input="(value: string) => (findText = value)">
			<template #prefix>
				<span class="lucide-search size-3.5 text-ink-gray-5" aria-hidden="true" />
			</template>
		</BuilderInput>
		<BuilderInput
			v-if="isReplaceMode"
			:placeholder="__('Replace with')"
			:modelValue="replaceText"
			@input="(value: string) => (replaceText = value)">
			<template #prefix>
				<span class="lucide-corner-down-right size-3.5 text-ink-gray-5" aria-hidden="true" />
			</template>
		</BuilderInput>

		<div
			v-if="isSelectionScope"
			class="flex h-6 items-center gap-1.5 rounded-4 pl-2 pr-1 text-xs"
			:class="
				results.scopeMissing ? 'bg-surface-amber-1 text-ink-amber-7' : 'bg-surface-gray-2 text-ink-gray-7'
			">
			<span class="lucide-square-dashed-mouse-pointer size-3 shrink-0" aria-hidden="true" />
			<span class="flex-1 truncate">
				{{ results.scopeMissing ? __("The selected blocks are no longer here") : scopeLabel }}
			</span>
			<button
				type="button"
				class="flex size-4 items-center justify-center rounded-4 hover:bg-surface-gray-4"
				:aria-label="__('Search the whole page')"
				@click="setScope('page')">
				<span class="lucide-x size-3" aria-hidden="true" />
			</button>
		</div>

		<template v-if="query.text && results.blocks.length">
			<div class="flex h-6 items-center justify-between gap-2">
				<span class="text-xs text-ink-gray-5">{{ summary }}</span>
				<Button
					v-if="isReplaceMode"
					size="sm"
					:label="__('Replace All')"
					:loading="replacing"
					:disabled="!replaceableMatches.length"
					@click="replace(replaceableMatches)" />
			</div>
			<div class="-mx-1 max-h-60 overflow-y-auto">
				<div
					v-for="result in visibleBlocks"
					:key="result.blockId"
					class="rounded-4"
					:class="{ 'bg-surface-gray-1': isSelected(result.blockId) }"
					@mouseenter="setHoveredBlock(result.blockId)"
					@mouseleave="setHoveredBlock(null)">
					<button
						type="button"
						class="flex h-6 w-full items-center gap-1.5 rounded-4 px-1.5 text-left hover:bg-surface-gray-2"
						@click="canvasStore.selectBlockSearchResult(result.blockId)">
						<span class="size-3 shrink-0" :class="[result.icon, result.iconClass]" aria-hidden="true" />
						<span class="truncate text-xs font-medium text-ink-gray-8">{{ result.name }}</span>
					</button>
					<div
						v-for="match in result.matches"
						:key="`${match.domain}:${match.path}`"
						class="group relative flex h-6 cursor-pointer items-center gap-2 rounded-4 pl-6 pr-1 text-xs hover:bg-surface-gray-2"
						@click="canvasStore.selectBlockSearchResult(result.blockId)">
						<span class="max-w-[45%] shrink-0 truncate text-ink-gray-5">{{ match.label }}</span>
						<!-- v-text keeps template whitespace out of the snippet -->
						<span
							class="min-w-0 flex-1 truncate text-ink-gray-8"
							:class="{ 'font-mono': match.domain !== 'content' }">
							<template v-for="(part, index) in getSnippet(match)" :key="index">
								<mark
									v-if="part.highlight"
									class="rounded-sm bg-surface-amber-2 px-px text-ink-gray-9"
									v-text="part.text" />
								<span v-else v-text="part.text" />
							</template>
						</span>
						<template v-if="isReplaceMode">
							<!-- overlays the row end on hover, so snippets keep the full width -->
							<Button
								v-if="match.replaceable"
								size="sm"
								variant="outline"
								class="absolute right-1 !h-5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
								:label="__('Replace')"
								:disabled="replacing"
								@click.stop="replace([match])" />
							<Tooltip
								v-else
								:text="match.inherited ? __('Set by the component') : __('Tags can only be searched')">
								<span class="lucide-lock size-3 shrink-0 text-ink-gray-4" aria-hidden="true" />
							</Tooltip>
						</template>
					</div>
				</div>
				<div v-if="hiddenBlockCount" class="px-1.5 py-1 text-xs text-ink-gray-5">
					{{ __("{0} more blocks not shown", [hiddenBlockCount]) }}
				</div>
			</div>
		</template>
		<p v-else-if="!results.scopeMissing" class="py-1 text-center text-xs text-ink-gray-5">
			{{ query.text ? __("No matches") : __("Search text, styles, data, tags and classes") }}
		</p>
	</div>
</template>
<script setup lang="ts">
import useBuilderStore from "@/stores/builderStore";
import useCanvasStore from "@/stores/canvasStore";
import { __ } from "@/translation";
import { getBlockSearchDomains } from "@/utils/block/tree";
import { watchDebounced } from "@vueuse/core";
import { Checkbox, Popover, TabButtons, toast, Tooltip } from "frappe-ui";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

// long result lists render only their first blocks; Replace All still covers every match
const MAX_VISIBLE_BLOCKS = 100;
const SNIPPET_LEAD = 16;
const SNIPPET_LENGTH = 80;
// matches the layers panel
const COMPONENT_ICON_CLASS =
	"text-purple-500 opacity-80 dark:opacity-100 dark:brightness-125 dark:saturate-[0.3]";

defineProps<{ headerTarget?: HTMLElement | null }>();

const builderStore = useBuilderStore();
const canvasStore = useCanvasStore();

// UI state only: the query, scope, results and replacing live in canvasStore and the search engine
const findInput = ref<{ $el: HTMLElement } | null>(null);
const findText = ref(canvasStore.blockSearchQuery.text);
const replaceText = ref("");
const mode = ref<"search" | "replace">("search");
const replacing = ref(false);

const modeOptions = [
	{ label: __("Search"), value: "search" },
	{ label: __("Replace"), value: "replace" },
];

const domains = getBlockSearchDomains();
const query = computed(() => canvasStore.blockSearchQuery);
const results = computed(() => canvasStore.blockSearchResults);
const canReplace = computed(() => !builderStore.readOnlyMode);
const isReplaceMode = computed(() => canReplace.value && mode.value === "replace");

const toolClass = (active: boolean) => [
	"flex size-7 items-center justify-center rounded-6 disabled:cursor-not-allowed disabled:opacity-40",
	active
		? "bg-surface-gray-3 text-ink-gray-9"
		: "text-ink-gray-5 hover:bg-surface-gray-2 hover:text-ink-gray-7",
];

// an empty domain filter searches everything, so show that as every box ticked
const isFiltered = computed(() => query.value.filters.domains.length > 0);
const activeDomains = computed(() =>
	isFiltered.value ? query.value.filters.domains : domains.map(({ domain }) => domain),
);

function toggleDomain(domain: BlockSearchDomain) {
	const active = activeDomains.value;
	const next = active.includes(domain) ? active.filter((d) => d !== domain) : [...active, domain];
	query.value.filters.domains = next.length === domains.length ? [] : next;
}

const isSelectionScope = computed(() => query.value.scope.type === "selection");
const canSearchSelection = computed(
	() => isSelectionScope.value || Boolean(canvasStore.activeCanvas?.selectedBlockIds.size),
);
const setScope = (type: BlockSearchScope["type"]) => canvasStore.setBlockSearchScope(type);

const scopeLabel = computed(() => {
	const scope = query.value.scope;
	if (scope.type !== "selection") return "";
	const name = blockInfo(scope.blockIds[0]).name;
	return scope.blockIds.length > 1
		? __("In {0} and {1} more", [name, scope.blockIds.length - 1])
		: __("In {0}", [name]);
});

const summary = computed(() => {
	const { occurrenceCount, blocks } = results.value;
	const matches = occurrenceCount === 1 ? __("1 match") : __("{0} matches", [occurrenceCount]);
	return blocks.length === 1
		? __("{0} in 1 block", [matches])
		: __("{0} in {1} blocks", [matches, blocks.length]);
});

const visibleBlocks = computed(() =>
	results.value.blocks
		.slice(0, MAX_VISIBLE_BLOCKS)
		.map((result) => ({ ...result, ...blockInfo(result.blockId) })),
);
const hiddenBlockCount = computed(() => results.value.blocks.length - visibleBlocks.value.length);
const replaceableMatches = computed(() =>
	results.value.blocks.flatMap((block) => block.matches).filter((match) => match.replaceable),
);

async function replace(matches: BlockSearchMatch[]) {
	replacing.value = true;
	const replaced = await canvasStore.replaceBlockSearchMatches(matches, replaceText.value);
	replacing.value = false;
	if (replaced < matches.length) {
		toast.warning(__("Some matches changed since the search and were skipped"));
	} else if (matches.length > 1) {
		const occurrences = matches.reduce((total, match) => total + match.ranges.length, 0);
		toast.success(__("Replaced {0} matches", [occurrences]));
	}
}

const isSelected = (blockId: string) => Boolean(canvasStore.activeCanvas?.selectedBlockIds.has(blockId));
const setHoveredBlock = (blockId: string | null) => canvasStore.activeCanvas?.setHoveredBlock(blockId);

function blockInfo(blockId: string) {
	const block = canvasStore.activeCanvas?.findBlock(blockId);
	if (!block) return { name: blockId, icon: "lucide-square", iconClass: "text-ink-gray-5" };
	return {
		name: block.getBlockDescription(),
		icon: block.extendedFromComponent ? "lucide-layout-dashboard" : block.getIcon(),
		iconClass: block.isExtendedFromComponent() ? COMPONENT_ICON_CLASS : "text-ink-gray-5",
	};
}

// a window around the first match, with every match inside it highlighted
function getSnippet({ value, ranges }: BlockSearchMatch) {
	const start = Math.max(0, ranges[0].start - SNIPPET_LEAD);
	const end = Math.min(value.length, start + SNIPPET_LENGTH);
	const parts = [{ text: start > 0 ? "…" : "", highlight: false }];
	let cursor = start;
	for (const range of ranges.filter((range) => range.start < end)) {
		parts.push({ text: value.slice(cursor, range.start), highlight: false });
		parts.push({ text: value.slice(range.start, Math.min(range.end, end)), highlight: true });
		cursor = Math.min(range.end, end);
	}
	parts.push({ text: value.slice(cursor, end) + (end < value.length ? "…" : ""), highlight: false });
	return parts.filter((part) => part.text);
}

watchDebounced(findText, (text) => (query.value.text = text), { debounce: 150 });

onMounted(() => findInput.value?.$el.querySelector("input")?.focus());
onBeforeUnmount(() => setHoveredBlock(null));
</script>
