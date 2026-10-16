import type Block from "@/block";
import AttributePropertyControl from "@/components/Controls/AttributePropertyControl.vue";
import Autocomplete from "@/components/Controls/Autocomplete.vue";
import FormDestinationsInput from "@/components/Controls/FormDestinationsInput.vue";
import InlineInput from "@/components/Controls/InlineInput.vue";
import { getLinkablePageOptions, linkablePages } from "@/data/allWebPages";
import blockController from "@/utils/blockController";
import { __ } from "@/translation";

const formSectionProperties = [
	{
		component: FormDestinationsInput,
		getProps: () => {
			return {
				label: __("Send to"),
				description: __("Each submission is emailed or posted to these destinations."),
				modelValue: blockController.getFirstSelectedBlock().getFormDestinations(),
			};
		},
		searchKeyWords: "Send to, Email, Webhook, Submissions, Notify, Destination, form",
		events: {
			"update:modelValue": (destinations: FormDestination[]) =>
				blockController
					.getSelectedBlocks()
					.forEach((block: Block) => block.setFormDestinations(destinations)),
		},
	},
	{
		component: AttributePropertyControl,
		getProps: () => {
			return {
				label: __("Redirect"),
				propertyKey: "data-redirect",
				component: Autocomplete,
				options: getLinkablePageOptions(),
				onFocus: () => linkablePages.reload(),
				showInputAsOption: true,
				placeholder: __("URL or /page"),
				getModelValue: () => blockController.getEffectiveAttribute("data-redirect") || "",
				setModelValue: (val: string) =>
					blockController.setEffectiveAttribute("data-redirect", val || undefined),
			};
		},
		searchKeyWords: "Redirect, After Submit, Thank You, Success Page, URL, form",
	},
	{
		component: InlineInput,
		getProps: () => {
			return {
				label: __("Tracking"),
				placeholder: __("ID"),
				modelValue: blockController.getEffectiveAttribute("data-tracking-id") || "",
				description: __("Counts each submission under this ID in Analytics, when view tracking is on."),
			};
		},
		searchKeyWords: "Tracking, Tracking ID, Analytics, Conversion, Submissions, form",
		events: {
			"update:modelValue": (val: string) =>
				blockController.setEffectiveAttribute("data-tracking-id", val || undefined),
		},
	},
];

export default {
	name: __("Form"),
	properties: formSectionProperties,
	condition: () => blockController.isForm(),
};
