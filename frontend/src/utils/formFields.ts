import type Block from "@/block";

interface FormFieldSchema {
	fieldname: string;
	label: string;
	fieldtype: string;
	options?: string;
	reqd: boolean;
}

// the DocType field an input type is saved as; the rest are saved as Data
const FIELDTYPES: Record<string, string> = {
	checkbox: "Check",
	number: "Float",
	date: "Date",
	time: "Time",
	"datetime-local": "Datetime",
	password: "Password",
	color: "Color",
};

// inputs that only act on the form, and files, which a submission can't carry
const SKIPPED_INPUT_TYPES = new Set(["submit", "reset", "button", "image", "file"]);

// the fields a form submits, in order; a radio group is one field
function getFormFields(block: Block): Block[] {
	return block.getChildren().flatMap((child) => {
		if (child.isRadioGroup() || child.isSelect()) return [child];
		if (child.isInput()) {
			const skipped =
				child.isRadio() || SKIPPED_INPUT_TYPES.has(child.getEffectiveAttribute("type") as string);
			return skipped ? [] : [child];
		}
		return getFormFields(child);
	});
}

function getFieldSchema(field: Block): FormFieldSchema {
	return {
		fieldname: String(getNamedBlocks(field)[0]?.getEffectiveAttribute("name") || ""),
		label: getFieldLabel(field),
		fieldtype: getFieldType(field),
		options: getFieldOptions(field),
		reqd: field.isRadioGroup() ? field.isGroupRequired() : field.getEffectiveAttribute("required") != null,
	};
}

// a submission is saved by input name, so each input is named after the field it saves to
function nameFormFields(fields: Block[], fieldnames: string[]) {
	fields.forEach((field, index) =>
		getNamedBlocks(field).forEach((block) => block.setEffectiveAttribute("name", fieldnames[index])),
	);
}

const getNamedBlocks = (field: Block) => (field.isRadioGroup() ? field.getRadios() : [field]);

function getFieldLabel(field: Block) {
	const label = field.getEffectiveAttribute("aria-label") || field.getEffectiveAttribute("placeholder");
	if (label) return String(label);
	// a radio group's heading, or the text of the <label> a select or checkbox sits in
	const labelled = field.isRadioGroup() ? field : field.getParentBlock();
	if (!labelled || !(field.isRadioGroup() || labelled.getElement() === "label")) return "";
	return labelled
		.getChildren()
		.filter((child) => child.isText())
		.map((child) => child.getTextContent())
		.join(" ")
		.trim();
}

function getFieldType(field: Block) {
	if (field.isRadioGroup() || field.isSelect()) return "Select";
	if (field.isTextarea()) return "Small Text";
	return FIELDTYPES[field.getEffectiveAttribute("type") as string] || "Data";
}

function getFieldOptions(field: Block) {
	if (field.isRadioGroup()) {
		return field
			.getRadios()
			.map((radio) => radio.getEffectiveAttribute("value"))
			.filter(Boolean)
			.join("\n");
	}
	// an option without a value submits its label; the placeholder's empty value is no choice
	if (field.isSelect()) {
		return field
			.getOptions()
			.map((option) => option.getEffectiveAttribute("value") ?? option.getTextContent())
			.filter(Boolean)
			.join("\n");
	}
	if (field.getEffectiveAttribute("type") === "email") return "Email";
}

export { getFieldSchema, getFormFields, nameFormFields };
