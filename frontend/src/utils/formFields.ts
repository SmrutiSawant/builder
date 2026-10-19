import type Block from "@/block";
import { __ } from "@/translation";
import { getBlockInstance, getBlockObject } from "@/utils/helpers";
import { createResource, toast } from "frappe-ui";

interface FormFieldSchema {
	fieldname: string;
	label: string;
	fieldtype: string;
	options?: string;
	reqd: boolean;
}

interface DoctypeField {
	fieldname: string;
	label: string;
	fieldtype: string;
	options?: string;
	needed: boolean;
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

// the input type a needed field is added with; a field of any other type, like a Link, isn't added
const INPUT_TYPES: Record<string, string> = {
	Data: "text",
	"Small Text": "text",
	Text: "text",
	"Long Text": "text",
	Int: "number",
	Float: "number",
	Currency: "number",
	Percent: "number",
	Date: "date",
	Time: "time",
	Datetime: "datetime-local",
	Password: "password",
	Color: "color",
	Phone: "tel",
};

const LONG_TEXT_FIELDTYPES = new Set(["Small Text", "Text", "Long Text"]);

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
		fieldname: getFieldName(field),
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

// a submission is saved by input name, so a picked DocType is checked against the form's inputs
async function checkFormDoctype(form: Block, doctype: string, createDoctype?: () => void) {
	const fields = await createResource({ url: "builder.api.get_form_doctype_fields" }).submit({ doctype });
	const check = new FormDoctypeCheck(form, doctype, fields, createDoctype);
	if (check.describeGaps()) check.warn();
}

class FormDoctypeCheck {
	constructor(
		private form: Block,
		private doctype: string,
		private fields: DoctypeField[],
		// offered in place of a fix when the form can't fill a needed field
		private createDoctype?: () => void,
	) {}

	// an input named after no field is dropped, and a needed field no input is named after fails each submission
	getGaps() {
		const inputs = getFormFields(this.form);
		const names = inputs.map(getFieldName);
		return {
			missing: this.fields.filter((df) => df.needed && !names.includes(df.fieldname)),
			dropped: inputs.filter((input) => !this.fields.some((df) => df.fieldname === getFieldName(input))),
		};
	}

	describeGaps() {
		const { unfillable } = this.planFix();
		// the form can't save here whatever its inputs are, so nothing else about them is worth saying
		if (unfillable.length) {
			return __("Submissions will fail: {0} needs {1}, which a form can't fill in.", [
				this.doctype,
				unfillable.map((df) => df.label).join(", "),
			]);
		}
		const { missing, dropped } = this.getGaps();
		const droppedLabels = dropped.map((input) => getFieldLabel(input) || getFieldName(input)).filter(Boolean);
		return [
			missing.length &&
				__("Submissions will fail: {0} needs {1}, which the form has no input for.", [
					this.doctype,
					missing.map((df) => df.label).join(", "),
				]),
			droppedLabels.length &&
				__("{0} has no field for {1}, which won't be saved.", [this.doctype, droppedLabels.join(", ")]),
		]
			.filter(Boolean)
			.join(" ");
	}

	// the inputs to rename after the field they match, the needed fields to add an input for, and the ones
	// no input can be added for, like a Link
	planFix() {
		const taken = new Set(getFormFields(this.form).map(getFieldName));
		const renames = new Map<Block, DoctypeField>();
		const { dropped } = this.getGaps();
		for (const matches of FIELD_MATCHERS) {
			for (const input of dropped.filter((input) => !renames.has(input))) {
				const df = this.fields.find((df) => !taken.has(df.fieldname) && matches(input, df));
				if (!df) continue;
				renames.set(input, df);
				taken.add(df.fieldname);
			}
		}
		const remaining = this.fields.filter((df) => df.needed && !taken.has(df.fieldname));
		const additions = remaining.filter((df) => getInputTemplate(this.form, df));
		const unfillable = remaining.filter((df) => !additions.includes(df));
		return { renames, additions, unfillable };
	}

	warn() {
		toast.warning(__("This form doesn't match {0}", [this.doctype]), {
			// picking another DocType replaces the warning
			id: "form-doctype-check",
			description: this.describeGaps(),
			duration: 15000,
			action: this.getAction(),
		});
	}

	// a fix can't make submissions save while a needed field stays empty, so a new DocType is offered instead
	getAction() {
		const { renames, additions, unfillable } = this.planFix();
		if (unfillable.length) {
			return this.createDoctype && { label: __("New DocType"), onClick: this.createDoctype };
		}
		if (renames.size || additions.length) return { label: __("Fix form"), onClick: () => this.fix() };
	}

	fix() {
		const { renames, additions } = this.planFix();
		renames.forEach((df, input) => nameFormFields([input], [df.fieldname]));
		additions.forEach((df) => addFormInput(this.form, df));
		const gaps = this.describeGaps();
		// a new toast, since the warning closes once its action runs
		if (gaps) {
			toast.warning(__("The form still doesn't match {0}", [this.doctype]), {
				description: gaps,
				duration: 15000,
			});
		} else {
			toast.success(__("The form now matches {0}", [this.doctype]));
		}
	}
}

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// an input matches the field its name or label spells, or failing that, an email input an email field
const FIELD_MATCHERS = [
	(input: Block, df: DoctypeField) => {
		const keys = [df.label, df.fieldname].map(normalize);
		return [getFieldName(input), getFieldLabel(input)]
			.map(normalize)
			.some((key) => key && keys.includes(key));
	},
	(input: Block, df: DoctypeField) =>
		input.getEffectiveAttribute("type") === "email" && df.options === "Email",
];

const getInputType = (df: DoctypeField) => (df.options === "Email" ? "email" : INPUT_TYPES[df.fieldtype]);

// one of the form's own text inputs, so an added one is styled the same
function getInputTemplate(form: Block, df: DoctypeField) {
	if (!getInputType(df)) return;
	const inputs = getFormFields(form).filter(
		(field) => field.isInput() && !field.isCheckable() && field.getEffectiveAttribute("type") !== "hidden",
	);
	return (
		(LONG_TEXT_FIELDTYPES.has(df.fieldtype) && inputs.find((input) => input.isTextarea())) ||
		inputs.find((input) => !input.isTextarea()) ||
		inputs[0]
	);
}

// added after the last field, at the form's own level so it isn't put inside that field's row
function addFormInput(form: Block, df: DoctypeField) {
	const template = getInputTemplate(form, df) as Block;
	const attributes = {
		name: df.fieldname,
		placeholder: df.label,
		"aria-label": df.label,
		type: template.isTextarea() ? undefined : getInputType(df),
		required: "required",
	};
	const input = getBlockInstance({ ...getBlockObject(template), attributes, customAttributes: {} }, false);
	const anchor = getFormChild(form, getFormFields(form).at(-1) as Block);
	form.addChild(input, form.getChildIndex(anchor) + 1, false);
}

const getFormChild = (form: Block, block: Block): Block =>
	block.getParentBlock()?.blockId === form.blockId
		? block
		: getFormChild(form, block.getParentBlock() as Block);

const getFieldName = (field: Block) => String(getNamedBlocks(field)[0]?.getEffectiveAttribute("name") || "");

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

export { checkFormDoctype, getFieldSchema, getFormFields, nameFormFields };
