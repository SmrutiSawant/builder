import type Block from "@/block";
import useBuilderStore from "@/stores/builderStore";
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
	find(value: string): BlockSearchRange[];
	equals(value: string): boolean;
}

interface SearchDomainHandler {
	domain: BlockSearchDomain;
	label(): string;
	find(block: Block, matcher: SearchMatcher): BlockSearchMatch[];
	// replaces the match's ranges; false when the value is stale or not replaceable
	replace(block: Block, match: BlockSearchMatch, replacement: string): boolean;
}

interface StoredValue {
	path: string;
	label: string;
	value: string;
	// absent when the value is search-only
	set?(value: string): void;
	// read from what the block renders, which already falls back to the component's content
	rendered?: boolean;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// case-insensitive and literal: the query is never read as a pattern
function createMatcher(text: string): SearchMatcher | null {
	if (!text) return null;
	const regex = new RegExp(escapeRegExp(text), "giu");
	return {
		find: (value) =>
			Array.from(value.matchAll(regex), (match) => ({
				start: match.index,
				end: match.index + match[0].length,
			})),
		equals: (value) => value.toLowerCase() === text.toLowerCase(),
	};
}

const findExact = (matcher: SearchMatcher, value: string) =>
	matcher.equals(value) ? [{ start: 0, end: value.length }] : [];

// splices the replacement in as plain text, so "$&" or "$1" stay literal; null for overlapping or out-of-range ranges
function replaceRanges(value: string, ranges: BlockSearchRange[], replacement: string) {
	let result = "";
	let cursor = 0;
	for (const { start, end } of [...ranges].sort((a, b) => a.start - b.start)) {
		if (start < cursor || end <= start || end > value.length) return null;
		result += value.slice(cursor, start) + replacement;
		cursor = end;
	}
	return result + value.slice(cursor);
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
		.filter((value) => !ownPaths.has(value.path) && !value.rendered)
		.map((value) => ({ ...value, inherited: true }));
	return [...own, ...inherited];
}

function createEntryDomain(
	domain: BlockSearchDomain,
	label: () => string,
	storedValues: (block: Block) => StoredValue[],
	findRanges = (matcher: SearchMatcher, value: string) => matcher.find(value),
): SearchDomainHandler {
	return {
		domain,
		label,
		find(block, matcher) {
			return getSearchEntries(block, storedValues).flatMap(({ set, ...entry }): BlockSearchMatch[] => {
				const ranges = findRanges(matcher, entry.value);
				if (!ranges.length) return [];
				const replaceable = Boolean(set) && !entry.inherited;
				return [{ ...entry, blockId: block.blockId, domain, ranges, replaceable }];
			});
		},
		replace(block, match, replacement) {
			if (!match.replaceable) return false;
			const current = storedValues(block).find((value) => value.path === match.path);
			if (!current?.set || current.value !== match.value) return false;
			const value = replaceRanges(current.value, match.ranges, replacement);
			if (value === null) return false;
			current.set(value);
			return true;
		},
	};
}

const nonTextParents = new Set(["script", "style"]);

// mirrors BuilderBlock: every other block renders its innerHTML as raw HTML or not at all
function rendersText(block: Block) {
	if (block.isInlineSVG()) return false;
	if (block.isLink() || block.isButton()) return !block.hasChildren();
	return block.isText();
}

// <template> parses inertly: no scripts run and no images load
function parseContent(html: string) {
	const template = document.createElement("template");
	template.innerHTML = html;
	return template;
}

// only the text the canvas shows is matched, never tag names, attributes or entities
function getTextNodes(root: Node) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	while (walker.nextNode()) {
		const node = walker.currentNode as Text;
		if (!nonTextParents.has(node.parentElement?.localName || "")) nodes.push(node);
	}
	return nodes;
}

const getText = (nodes: Text[]) => nodes.map((node) => node.data).join("");

// ranges index the joined text; a match never spans two text nodes, so a replace can't split formatting
function findInTextNodes(nodes: Text[], matcher: SearchMatcher): BlockSearchRange[] {
	let offset = 0;
	return nodes.flatMap((node) => {
		const shift = offset;
		offset += node.data.length;
		return matcher.find(node.data).map(({ start, end }) => ({ start: start + shift, end: end + shift }));
	});
}

// each range has to sit inside one text node, as findInTextNodes reports them
function replaceInTextNodes(nodes: Text[], ranges: BlockSearchRange[], replacement: string) {
	let offset = 0;
	let assigned = 0;
	const texts = nodes.map((node) => {
		const shift = offset;
		offset += node.data.length;
		const nodeRanges = ranges
			.filter(({ start }) => start >= shift && start < offset)
			.map(({ start, end }) => ({ start: start - shift, end: end - shift }));
		assigned += nodeRanges.length;
		return replaceRanges(node.data, nodeRanges, replacement);
	});
	if (assigned !== ranges.length || texts.includes(null)) return false;
	nodes.forEach((node, index) => (node.data = texts[index] as string));
	return true;
}

const contentDomain: SearchDomainHandler = {
	domain: "content",
	label: () => __("Content"),
	find(block, matcher) {
		if (!rendersText(block)) return [];
		const nodes = getTextNodes(parseContent(block.getInnerHTML()).content);
		const ranges = findInTextNodes(nodes, matcher);
		if (!ranges.length) return [];
		return [
			{
				blockId: block.blockId,
				domain: "content",
				path: "innerHTML",
				label: __("Content"),
				value: getText(nodes),
				ranges,
				inherited: !block.innerHTML,
				// same as typing on the canvas: an instance gets its own content override
				replaceable: true,
			},
		];
	},
	replace(block, match, replacement) {
		// checked again so a hand-built match can't rewrite a raw HTML block
		if (!rendersText(block)) return false;
		const template = parseContent(block.getInnerHTML());
		const nodes = getTextNodes(template.content);
		if (getText(nodes) !== match.value) return false;
		if (!replaceInTextNodes(nodes, match.ranges, replacement)) return false;
		block.setInnerHTML(template.innerHTML);
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

// a number or boolean stays one while the replaced text still reads as one
function toStyleValue(previous: StyleValue, value: string): StyleValue {
	if (typeof previous === "number" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	if (typeof previous === "boolean" && (value === "true" || value === "false")) return value === "true";
	return value;
}

// writes to the breakpoint the value was found in, unlike setStyle() which uses the active one
function getStyleValues(block: Block, map: StyleMap): StoredValue[] {
	const styles = block[map] || {};
	return Object.entries(styles)
		.filter(([, value]) => hasStyleValue(value))
		.map(([style, value]) => ({
			path: `${map}.${style}`,
			label: `${styleMaps[map]()} · ${style}`,
			value: String(value),
			// an emptied value removes the style, as setStyle() does
			set: (newValue: string) => {
				if (newValue.trim()) styles[style as styleProperty] = toStyleValue(value, newValue);
				else delete styles[style as styleProperty];
			},
		}));
}

// "color: red; background: url(a;b)" -> [["color", "red"], ["background", "url(a;b)"]]; read as written,
// since the browser's style API turns #ff0000 into rgb(255, 0, 0)
function parseDeclarations(style: string) {
	return style
		.split(/;(?![^(]*\))/)
		.map((declaration) => {
			const colon = declaration.indexOf(":");
			if (colon === -1) return ["", ""];
			return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
		})
		.filter(([property, value]) => property && value)
		.map(([property, value]) => [property.toLowerCase(), value]);
}

// inline styles the text editor puts on parts of the text, e.g. <span style="color: red">
function getTextFormattingValues(block: Block): StoredValue[] {
	if (!rendersText(block)) return [];
	const template = parseContent(block.getInnerHTML());
	return [...template.content.querySelectorAll<HTMLElement>("[style]")].flatMap((element, index) => {
		const declarations = parseDeclarations(element.getAttribute("style") || "");
		return declarations.map(([property, value], position) => ({
			path: `innerHTML.style.${index}.${position}`,
			label: __("Text style · {0}", [property]),
			value,
			rendered: true,
			// only this declaration changes; an emptied value drops it, and the text and other formatting stay
			set: (newValue: string) => {
				const next = newValue.trim()
					? declarations.map(([p, v], i) => [p, i === position ? newValue : v])
					: declarations.filter((_, i) => i !== position);
				if (next.length) element.setAttribute("style", next.map(([p, v]) => `${p}: ${v}`).join("; "));
				else element.removeAttribute("style");
				block.setInnerHTML(template.innerHTML);
			},
		}));
	});
}

const stylesDomain = createEntryDomain(
	"styles",
	() => __("Styles"),
	(block) => [
		...(Object.keys(styleMaps) as StyleMap[]).flatMap((map) => getStyleValues(block, map)),
		...getTextFormattingValues(block),
	],
);

function getDataKeyValue(block: Block): StoredValue[] {
	if (!block.dataKey?.key) return [];
	return [
		{
			path: "dataKey",
			label: __("Data Key"),
			value: block.dataKey.key,
			// an emptied key unbinds the block, as setDataKey() does
			set: (key) => (block.dataKey = key ? { ...block.dataKey, key } : {}),
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
			set: (key) => {
				if (key) dynamicValue.key = key;
				else block.removeDynamicValue(dynamicValue.property, dynamicValue.type as BlockDataKeyType);
			},
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
			// an emptied key clears the condition the way VisibilityInput does
			set: (key) =>
				(block.visibilityCondition = key ? { ...condition, key } : { key: undefined, comesFrom: undefined }),
		},
	];
}

// a dynamic prop's value is the data key it reads; static props hold literal values
function getDynamicPropKeys(block: Block): StoredValue[] {
	return Object.entries(block.props || {})
		.filter(([, prop]) => prop.isDynamic && prop.value)
		.map(([name, prop]) => ({
			path: `props.${name}`,
			label: __("Prop {0}", [name]),
			value: prop.value as string,
			set: (key) => (prop.value = key || null),
		}));
}

const dataDomain = createEntryDomain(
	"data",
	() => __("Data"),
	(block) => [
		...getDataKeyValue(block),
		...getDynamicValueKeys(block),
		...getVisibilityConditionValue(block),
		...getDynamicPropKeys(block),
	],
);

// search-only: changing the element is a structural edit, not a text replacement
const tagDomain = createEntryDomain(
	"tag",
	() => __("Tag"),
	(block) => (block.element ? [{ path: "element", label: __("Tag"), value: block.element }] : []),
	findExact,
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

const searchDomains: SearchDomainHandler[] = [
	contentDomain,
	stylesDomain,
	dataDomain,
	tagDomain,
	classesDomain,
];

// handlers stay private so nothing can mutate blocks around replaceMatches' read-only check
export const getBlockSearchDomains = () =>
	searchDomains.map(({ domain, label }) => ({ domain, label: label() }));

function walkBlocks(block: Block, visit: (block: Block) => void) {
	visit(block);
	block.children?.forEach((child) => walkBlocks(child, visit));
}

// a selected block nested inside another selected block is already covered by its ancestor
function getScopeRoots(root: Block, scope: BlockSearchScope): Block[] {
	if (scope.type === "page") return [root];
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

export function searchBlocks(root: Block | null | undefined, query: BlockSearchQuery): BlockSearchResults {
	const scopeRoots = root ? getScopeRoots(root, query.scope) : [];
	// a missing scope stays as is rather than widening to the page: undo can bring its blocks back
	const scopeMissing = Boolean(root) && !scopeRoots.length;
	const results: BlockSearchResults = { blocks: [], matchCount: 0, occurrenceCount: 0, scopeMissing };
	const matcher = createMatcher(query.text);
	if (!matcher) return results;
	const domains = getActiveDomains(query.filters);
	scopeRoots.forEach((scopeRoot) =>
		walkBlocks(scopeRoot, (block) => {
			const matches = domains.flatMap((handler) => handler.find(block, matcher));
			if (!matches.length) return;
			results.blocks.push({ blockId: block.blockId, matches });
			results.matchCount += matches.length;
			results.occurrenceCount += matches.reduce((total, match) => total + match.ranges.length, 0);
		}),
	);
	return results;
}

// replaces each match's ranges, so passing a subset of ranges replaces just those occurrences;
// returns the matches that were replaced: ones whose value changed since the search are skipped
export function replaceMatches(root: Block, matches: BlockSearchMatch[], replacement: string) {
	const replaced: BlockSearchMatch[] = [];
	// read-only covers version previews, protected pages and site maintenance
	if (useBuilderStore().readOnlyMode) return replaced;
	const blocks = new Map<string, Block>();
	walkBlocks(root, (block) => blocks.set(block.blockId, block));
	for (const match of matches) {
		const block = blocks.get(match.blockId);
		const handler = searchDomains.find((domain) => domain.domain === match.domain);
		if (block && match.ranges.length && handler?.replace(block, match, replacement)) replaced.push(match);
	}
	return replaced;
}
