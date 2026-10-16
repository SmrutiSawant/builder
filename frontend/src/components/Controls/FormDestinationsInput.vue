<template>
	<div class="flex items-start justify-between gap-2">
		<InputLabel class="h-7 w-1/3 min-w-[88px] shrink-0" :description="description">{{ label }}</InputLabel>
		<div ref="list" class="flex w-full min-w-0 flex-col gap-1.5">
			<BuilderInput
				v-for="(destination, index) in modelValue"
				:key="index"
				:modelValue="destination.value"
				:placeholder="destinationTypes[destination.type].placeholder"
				hideClearButton
				@update:modelValue="(value: string) => update(index, value)"
				@keydown.stop>
				<template #prefix>
					<span
						:class="destinationTypes[destination.type].icon"
						class="size-3.5 text-ink-gray-5"
						:title="destinationTypes[destination.type].label"
						aria-hidden="true" />
				</template>
				<template #suffix>
					<button
						type="button"
						class="text-ink-gray-4 hover:text-ink-gray-7"
						tabindex="-1"
						:title="__('Remove')"
						@click="remove(index)">
						<span class="lucide-x size-3.5" aria-hidden="true" />
					</button>
				</template>
			</BuilderInput>
			<Dropdown :options="addOptions" size="sm">
				<Button
					variant="subtle"
					icon-left="lucide-plus"
					:label="__('Add...')"
					class="w-full"
					@focus="focusNewDestination" />
			</Dropdown>
		</div>
	</div>
</template>

<script setup lang="ts">
import InputLabel from "@/components/Controls/InputLabel.vue";
import { __ } from "@/translation";
import { Dropdown } from "frappe-ui";
import { ref } from "vue";

const props = defineProps<{
	label: string;
	description?: string;
	modelValue: FormDestination[];
}>();

const emit = defineEmits<{
	"update:modelValue": [destinations: FormDestination[]];
}>();

const destinationTypes = {
	email: { label: __("Email"), icon: "lucide-mail", placeholder: __("Email") },
	webhook: { label: __("Webhook"), icon: "lucide-webhook", placeholder: "https://" },
};

const list = ref<HTMLElement | null>(null);

const update = (index: number, value: string) =>
	emit(
		"update:modelValue",
		props.modelValue.map((destination, i) => (i === index ? { ...destination, value } : destination)),
	);

const remove = (index: number) =>
	emit(
		"update:modelValue",
		props.modelValue.filter((_, i) => i !== index),
	);

let added = false;

const add = (type: FormDestination["type"]) => {
	emit("update:modelValue", [...props.modelValue, { type, value: "" }]);
	added = true;
};

// the closing menu hands focus back to its button, which passes it on to the new, empty destination
const focusNewDestination = () => {
	if (!added) return;
	added = false;
	const inputs = list.value?.querySelectorAll("input");
	inputs?.[inputs.length - 1]?.focus();
};

const addOptions = Object.entries(destinationTypes).map(([type, { label, icon }]) => ({
	label,
	icon,
	onClick: () => add(type as FormDestination["type"]),
}));
</script>
