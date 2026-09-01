<template>
	<Popover :offset="20" placement="left">
		<template #target="{ open }">
			<Button class="w-full" variant="subtle" icon="lucide-pencil" @click.stop="open()" />
		</template>
		<template #body>
			<div
				@click.stop
				@mousedown.stop
				class="flex max-h-60 flex-col gap-3 overflow-auto rounded-lg bg-surface-base p-4 shadow-lg"
				:class="itemType === 'image' ? 'w-72' : 'w-60'">
				<div class="text-sm text-ink-gray-8">{{ __("Array Items:") }}</div>
				<ArrayEditor :arr :itemType @update:arr="updateModelValue" />
			</div>
		</template>
	</Popover>
</template>

<script setup lang="ts">
import { __ } from "@/translation";
import { Popover } from "frappe-ui";
import { computed } from "vue";
import ArrayEditor from "./ArrayEditor.vue";

const props = defineProps<{
	modelValue?: string;
	itemType?: "string" | "image";
}>();

const emit = defineEmits({
	"update:modelValue": (value: string) => true,
});

const arr = computed<string[]>(() => {
	try {
		const parsed = JSON.parse(props.modelValue || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
});

const updateModelValue = (value: string[]) => {
	emit("update:modelValue", JSON.stringify(value));
};
</script>
