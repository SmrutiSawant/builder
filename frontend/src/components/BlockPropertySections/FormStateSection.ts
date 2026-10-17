import InlineInput from "@/components/Controls/InlineInput.vue";
import blockController from "@/utils/blockController";
import { formStates } from "@/utils/formStates";
import { __ } from "@/translation";

// the variant a button shows in each state of its form, as Framer's Form state on a button
const formStateSectionProperties = formStates.map((state) => ({
	component: InlineInput,
	getProps: () => {
		const button = blockController.getFirstSelectedBlock();
		return {
			label: state.label,
			type: "select",
			options: button.getChildren().map((variant) => ({
				label: variant.getBlockDescription(),
				value: variant.blockId,
			})),
			modelValue: button.getFormStateVariant(state.value)?.blockId,
			description: __("The layer of this button shown in this form state."),
		};
	},
	searchKeyWords: `Form State, Variant, Button, ${state.label}, Loading, Spinner, Thank You, form`,
	events: {
		"update:modelValue": (variantId: string) =>
			blockController.getFirstSelectedBlock().setFormStateVariant(state.value, variantId),
	},
}));

export default {
	name: __("Form State"),
	properties: formStateSectionProperties,
	condition: () => blockController.hasFormStateVariants() && !blockController.multipleBlocksSelected(),
};
