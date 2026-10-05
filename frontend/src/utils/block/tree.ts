import type Block from "@/block";
import { __ } from "@/translation";
import { generateId } from "@/utils/helpers";

export function resetBlock(
	block: Block | BlockOptions,
	resetChildren: boolean = true,
	resetOverrides: boolean = true,
) {
	block.blockId = generateId();
	if (resetOverrides) {
		delete block.innerHTML;
		delete block.element;
		block.baseStyles = {};
		block.mobileStyles = {};
		block.tabletStyles = {};
		block.attributes = {};
		block.customAttributes = {};
		block.classes = [];
		block.dataKey = null;
		block.dynamicValues = [];
		block.props = {};
		block.clientScript = {};
		// @ts-ignore
		delete block.blockClientScript;
	}

	if (resetChildren) {
		block.children?.forEach((child) => {
			resetBlock(child, resetChildren, !Boolean(child.extendedFromComponent));
		});
	}
}

export function findBlockInTree(blockId: string, blocks: Block[]): Block | null {
	for (const block of blocks) {
		if (block.blockId === blockId) {
			return block;
		}
		if (block.children) {
			const found = findBlockInTree(blockId, block.children);
			if (found) {
				return found;
			}
		}
	}
	return null;
}

interface SearchMatcher {
	count(value: string): number;
	replace(value: string, replacement: string): string;
}

interface SearchDomainHandler {
	domain: BlockSearchDomain;
	label(): string;
	find(block: Block, matcher: SearchMatcher): BlockSearchMatch[];
	// replaces every occurrence in the matched value; false when the value is stale or not replaceable
	replace(block: Block, match: BlockSearchMatch, matcher: SearchMatcher, replacement: string): boolean;
}

interface StoredValue {
	path: string;
	label: string;
	value: string;
	// absent when the value is search-only
	set?(value: string): void;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// \b misses terms that start or end with punctuation, e.g. "-red"
const wordBoundary = (pattern: string) => `(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`;

function createMatcher(text: string, filters: BlockSearchFilters): SearchMatcher | null {
	if (!text) return null;
	const pattern = filters.wholeWord ? wordBoundary(escapeRegExp(text)) : escapeRegExp(text);
	const regex = new RegExp(pattern, filters.caseSensitive ? "gu" : "giu");
	return {
		count: (value) => value.match(regex)?.length ?? 0,
		// a function replacer keeps "$&" and "$1" in the replacement literal
		replace: (value, replacement) => value.replace(regex, () => replacement),
	};
}

// values an instance leaves unset fall through to its component, as Block's get*() accessors do
function getSearchEntries(
	block: Block,
	storedValues: (block: Block) => StoredValue[],
): (StoredValue & { inherited: boolean })[] {
	const own = storedValues(block).map((value) => ({ ...value, inherited: false }));
	const component = block.referenceComponent;
	if (!component) return own;
	const ownPaths = new Set(own.map((value) => value.path));
	const inherited = getSearchEntries(component, storedValues)
		.filter((value) => !ownPaths.has(value.path))
		.map((value) => ({ ...value, inherited: true }));
	return [...own, ...inherited];
}

function createEntryDomain(
	domain: BlockSearchDomain,
	label: () => string,
	storedValues: (block: Block) => StoredValue[],
): SearchDomainHandler {
	return {
		domain,
		label,
		find(block, matcher) {
			return getSearchEntries(block, storedValues).flatMap(({ set, ...entry }): BlockSearchMatch[] => {
				const occurrences = matcher.count(entry.value);
				if (!occurrences) return [];
				const replaceable = Boolean(set) && !entry.inherited;
				return [{ ...entry, blockId: block.blockId, domain, occurrences, replaceable }];
			});
		},
		replace(block, match, matcher, replacement) {
			if (!match.replaceable) return false;
			const current = storedValues(block).find((value) => value.path === match.path);
			if (!current?.set || current.value !== match.value) return false;
			current.set(matcher.replace(current.value, replacement));
			return true;
		},
	};
}

const nonTextParents = new Set(["script", "style"]);

// unset content falls through to the referenced component, as getInnerHTML() does
function getContent(block: Block): string {
	if (block.innerHTML) return String(block.innerHTML);
	return block.referenceComponent ? getContent(block.referenceComponent) : "";
}

// <template> parses inertly: no scripts run and no images load
function parseContent(html: string) {
	const template = document.createElement("template");
	template.innerHTML = html;
	return template;
}

// only text nodes are matched, so tag names, attributes and entities are never rewritten
function getTextNodes(root: Node) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		if (!nonTextParents.has(node.parentElement?.localName || "")) nodes.push(node);
	}
	return nodes;
}

const contentDomain: SearchDomainHandler = {
	domain: "content",
	label: () => __("Content"),
	find(block, matcher) {
		const content = getContent(block);
		if (!content) return [];
		const template = parseContent(content);
		const occurrences = getTextNodes(template.content).reduce(
			(total, node) => total + matcher.count(node.data),
			0,
		);
		if (!occurrences) return [];
		return [
			{
				blockId: block.blockId,
				domain: "content",
				path: "innerHTML",
				label: __("Content"),
				value: template.content.textContent || "",
				inherited: !block.innerHTML,
				occurrences,
				// same as typing on the canvas: an instance gets its own content override
				replaceable: true,
			},
		];
	},
	replace(block, match, matcher, replacement) {
		const template = parseContent(getContent(block));
		if ((template.content.textContent || "") !== match.value) return false;
		getTextNodes(template.content).forEach((node) => (node.data = matcher.replace(node.data, replacement)));
		block.innerHTML = template.innerHTML;
		return true;
	},
};

const styleMaps = {
	baseStyles: () => __("Desktop"),
	tabletStyles: () => __("Tablet"),
	mobileStyles: () => __("Mobile"),
};

type StyleMap = keyof typeof styleMaps;

const hasStyleValue = (value: StyleValue) => value !== null && value !== undefined && value !== "";

// writes to the breakpoint the value was found in, unlike setStyle() which uses the active one
function getStyleValues(block: Block, map: StyleMap): StoredValue[] {
	const styles = block[map] || {};
	return Object.entries(styles)
		.filter(([, value]) => hasStyleValue(value))
		.map(([style, value]) => ({
			path: `${map}.${style}`,
			label: `${styleMaps[map]()} · ${style}`,
			value: String(value),
			set: (newValue: string) => {
				if (newValue) styles[style as styleProperty] = newValue;
				else delete styles[style as styleProperty];
			},
		}));
}

const stylesDomain = createEntryDomain(
	"styles",
	() => __("Styles"),
	(block) => (Object.keys(styleMaps) as StyleMap[]).flatMap((map) => getStyleValues(block, map)),
);

function getDataKeyValue(block: Block): StoredValue[] {
	if (!block.dataKey?.key) return [];
	return [
		{
			path: "dataKey",
			label: __("Data Key"),
			value: block.dataKey.key,
			set: (key) => (block.dataKey = { ...block.dataKey, key }),
		},
	];
}

function getDynamicValueKeys(block: Block): StoredValue[] {
	return (block.dynamicValues || [])
		.filter((dynamicValue) => dynamicValue.key)
		.map((dynamicValue) => ({
			path: `dynamicValues.${dynamicValue.type}.${dynamicValue.property}`,
			label: __("Dynamic {0}", [dynamicValue.property || ""]),
			value: dynamicValue.key as string,
			set: (key) => (dynamicValue.key = key),
		}));
}

function getVisibilityConditionValue(block: Block): StoredValue[] {
	const condition = block.visibilityCondition;
	if (!condition?.key) return [];
	return [
		{
			path: "visibilityCondition",
			label: __("Visibility Condition"),
			value: condition.key,
			set: (key) => (block.visibilityCondition = { ...condition, key }),
		},
	];
}

const dataDomain = createEntryDomain(
	"data",
	() => __("Data"),
	(block) => [
		...getDataKeyValue(block),
		...getDynamicValueKeys(block),
		...getVisibilityConditionValue(block),
	],
);

// search-only: changing the element is a structural edit, not a text replacement
const tagDomain = createEntryDomain(
	"tag",
	() => __("Tag"),
	(block) => (block.element ? [{ path: "element", label: __("Tag"), value: block.element }] : []),
);

// a replacement may be empty (drops the class) or hold several classes
function replaceClass(classes: string[], target: string, value: string) {
	const replacement = value.split(/\s+/).filter(Boolean);
	return [...new Set(classes.flatMap((name) => (name === target ? replacement : [name])))];
}

const classesDomain = createEntryDomain(
	"classes",
	() => __("CSS Classes"),
	(block) =>
		(block.classes || []).map((name) => ({
			path: `classes.${name}`,
			label: __("Class"),
			value: name,
			set: (value: string) => (block.classes = replaceClass(block.classes, name, value)),
		})),
);

export const searchDomains: SearchDomainHandler[] = [
	contentDomain,
	stylesDomain,
	dataDomain,
	tagDomain,
	classesDomain,
];

function walkBlocks(block: Block, visit: (block: Block) => void) {
	visit(block);
	block.children?.forEach((child) => walkBlocks(child, visit));
}

// a selected block nested inside another selected block is already covered by its ancestor
function getScopeRoots(root: Block, scope: BlockSearchScope): Block[] {
	if (scope.type === "all") return [root];
	const blockIds = new Set(scope.blockIds);
	const roots: Block[] = [];
	const collect = (block: Block) => {
		if (blockIds.has(block.blockId)) roots.push(block);
		else block.children?.forEach(collect);
	};
	collect(root);
	return roots;
}

function getActiveDomains(filters: BlockSearchFilters) {
	if (!filters.domains.length) return searchDomains;
	return searchDomains.filter((handler) => filters.domains.includes(handler.domain));
}

export function searchBlocks(root: Block, query: BlockSearchQuery): BlockSearchResults {
	const results: BlockSearchResults = { blocks: [], matchCount: 0, occurrenceCount: 0 };
	const matcher = createMatcher(query.text, query.filters);
	if (!matcher) return results;
	const domains = getActiveDomains(query.filters);
	getScopeRoots(root, query.scope).forEach((scopeRoot) =>
		walkBlocks(scopeRoot, (block) => {
			const matches = domains.flatMap((handler) => handler.find(block, matcher));
			if (!matches.length) return;
			results.blocks.push({ blockId: block.blockId, matches });
			results.matchCount += matches.length;
			results.occurrenceCount += matches.reduce((total, match) => total + match.occurrences, 0);
		}),
	);
	return results;
}

// matches whose value changed since the search are skipped, so callers should search again afterwards
export function replaceMatches(
	root: Block,
	query: BlockSearchQuery,
	matches: BlockSearchMatch[],
	replacement: string,
) {
	const matcher = createMatcher(query.text, query.filters);
	if (!matcher) return 0;
	const blocks = new Map<string, Block>();
	walkBlocks(root, (block) => blocks.set(block.blockId, block));
	let replaced = 0;
	for (const match of matches) {
		const block = blocks.get(match.blockId);
		const handler = searchDomains.find((domain) => domain.domain === match.domain);
		if (block && handler?.replace(block, match, matcher, replacement)) replaced++;
	}
	return replaced;
}
