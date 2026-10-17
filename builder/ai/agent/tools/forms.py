"""Connect a page form to real data — the 'make this form actually save' tool.

A form on a published Builder page is public (a guest fills it), so it saves
through its Send to: a DocType destination there is sealed into the page with the
form's field names, and builder.api.submit_form inserts only those fields with
ignore_permissions. The submission DocType needs NO guest permission.

`connect_form` (confirm-gated) does it on approval:
  1. a private submission DocType (System Manager only — no guest read),
  2. the <form> block's Send to pointed at it.
The user then reads submissions in Desk at /app/<doctype>.
"""

import re

import frappe

from builder.ai.agent import pending
from builder.ai.agent.registry import Tool
from builder.form_doctype import safe_fieldname
from builder.form_submission import collect_form_doctypes, walk_blocks

# Fieldtypes a public form can safely write. Anything else (Link, Table, Attach…)
# is coerced to Data. Select is deliberately EXCLUDED: an HTML <select> submits its
# option's `value` attr (e.g. "breathwork"), which rarely matches the DocType's
# Select option labels ("Breathwork & Stillness") — Frappe then rejects the insert
# with a validation error. Storing dropdowns as Data accepts whatever was chosen.
SAFE_FIELDTYPES = {"Data", "Small Text", "Text", "Int", "Float", "Check", "Date", "Datetime"}


def connected_submission_doctype(page_id: str) -> str | None:
	"""The submission DocType a form on this page already saves to, if any — read
	from its Send to, or from the 'Save <doctype> submissions' client script a form
	was wired with before. Lets a "where do my submissions go?" question be answered
	instead of creating a duplicate."""
	if not page_id or not frappe.db.exists("Builder Page", page_id):
		return None
	draft, published = frappe.db.get_value("Builder Page", page_id, ["draft_blocks", "blocks"])
	if doctypes := collect_form_doctypes(draft, published):
		return sorted(doctypes)[0]
	names = frappe.get_all(
		"Builder Page Client Script",
		filters={"parent": page_id, "parenttype": "Builder Page"},
		pluck="builder_script",
	)
	for name in names:
		m = re.match(r"^Save (.+) submissions$", name or "")
		if m and frappe.db.exists("DocType", m.group(1)):
			return m.group(1)
	return None


def request_connect_form(ctx, args: dict) -> str | None:
	"""Validate the proposal and raise the confirm card. Nothing is created until
	the user approves (see pending.apply_connect_form)."""
	if not getattr(ctx, "page_id", None):
		return "DECLINED: no page is open — build the form's page first."
	# A form here is already wired — very likely a "where do submissions go?" ask.
	# Answer with the existing DocType; don't create a duplicate (unless forced).
	if not args.get("force_new") and (connected := connected_submission_doctype(ctx.page_id)):
		return (
			f"ALREADY CONNECTED: a form on this page saves to the '{connected}' DocType — its "
			f"submissions are in Desk at /app/{desk_slug(connected)}. Do NOT create a new doctype; "
			f"just tell the user where to find the entries (give that link). Only pass force_new=true "
			f"if they explicitly want a SEPARATE, additional form."
		)
	doctype = (args.get("doctype_name") or "").strip()
	fields = [f for f in (args.get("fields") or []) if isinstance(f, dict) and f.get("fieldname")]
	form_block_id = (args.get("form_block_id") or "").strip()
	if not doctype or not fields or not form_block_id:
		return (
			"DECLINED: connect_form needs doctype_name, at least one field, and form_block_id "
			"(the ref of the <form> block that holds the inputs)."
		)
	if declined := check_form(ctx, form_block_id, [f["fieldname"] for f in fields]):
		return declined
	if frappe.db.exists("DocType", doctype) and not is_builder_submission_doctype(doctype):
		return (
			f"DECLINED: '{doctype}' already exists and isn't a Builder submission doctype — pick a new "
			f"name (e.g. '{doctype} Submission') so real data isn't touched."
		)
	summary = (
		f"Create the DocType '{doctype}' ({len(fields)} field(s)) and point this form's Send to at it? "
		f"You'll see entries in Desk at /app/{desk_slug(doctype)}."
	)
	payload = {
		"doctype_name": doctype,
		"fields": [normalize_field(f) for f in fields],
		"page_id": ctx.page_id,
		"form_block_id": form_block_id,
	}
	pending.request_confirmation(ctx, "connect_form", summary, payload)
	return None


def check_form(ctx, form_block_id: str, fieldnames: list[str]) -> str | None:
	"""A submission is saved by input name, from a real <form>: both are fixed with
	update_block before the user is asked, so what they approve is what saves."""
	tree = getattr(ctx, "tree", None)
	form = tree.resolve(form_block_id) if tree else None
	if form is None:
		return f"DECLINED: form_block_id '{form_block_id}' is not a block on this page — pass the form's ref."
	if (form.get("originalElement") or form.get("element")) != "form":
		return (
			"DECLINED: form_block_id must be a <form> block — set element: 'form' on the block that "
			"holds the inputs and submit button (update_block), then call connect_form again."
		)
	if unsafe := [f for f in fieldnames if safe_fieldname(frappe.scrub(f)) != f]:
		return (
			f"DECLINED: {', '.join(unsafe)} can't be fieldnames — use snake_case names that aren't "
			f"reserved (e.g. full_name, not name), rename those inputs to match, then call again."
		)
	names = get_input_names(form)
	if unnamed := [f for f in fieldnames if f not in names]:
		return (
			f'DECLINED: no input in the form is named {", ".join(unnamed)} — set name="<fieldname>" on '
			f"each input (update_block attributes) so it matches its field, then call connect_form again."
		)
	return None


def get_input_names(form: dict) -> set[str]:
	return {
		attributes["name"]
		for block in walk_blocks(form)
		if (block.get("originalElement") or block.get("element")) in ("input", "select", "textarea")
		for attributes in (block.get("attributes") or {}, block.get("customAttributes") or {})
		if attributes.get("name")
	}


def normalize_field(f: dict) -> dict:
	return {
		"fieldname": f["fieldname"],
		"label": f.get("label") or f["fieldname"].replace("_", " ").title(),
		"fieldtype": f.get("fieldtype") if f.get("fieldtype") in SAFE_FIELDTYPES else "Data",
	}


def is_builder_submission_doctype(name: str) -> bool:
	row = frappe.db.get_value("DocType", name, ["custom", "module"], as_dict=True)
	return bool(row and row.custom and row.module == "Builder")


def desk_slug(doctype: str) -> str:
	return frappe.scrub(doctype).replace("_", "-")


connect_form_tool = Tool(
	name="connect_form",
	side="terminal",
	description=(
		"Make a form on the page actually SAVE its submissions to the database. Use this whenever "
		"you build a real form that collects user input (contact, booking, signup, waitlist, RSVP). "
		"Under the hood it creates a private DocType for the submissions and points the form's Send to at "
		"it — the owner reads entries in Desk at /app/<doctype>. The inputs must sit in a <form> block "
		"(element: form) with the submit button, and each input's name attribute must equal its field's "
		"fieldname: set both with update_block first. One field per input/select; a radio group is one "
		"field. Ends your turn to confirm."
	),
	parameters={
		"type": "object",
		"properties": {
			"doctype_name": {
				"type": "string",
				"description": "Human name for the submissions DocType, e.g. 'Stillpoint Reservation'.",
			},
			"fields": {
				"type": "array",
				"description": "One entry per form input. fieldname must equal the input's name attribute.",
				"items": {
					"type": "object",
					"properties": {
						"fieldname": {
							"type": "string",
							"description": "snake_case; equals the input's name attr.",
						},
						"label": {"type": "string"},
						"fieldtype": {
							"type": "string",
							"description": "Data (default), Small Text, Text, Int, Float, Check, Date, Datetime. A dropdown or radio group is saved as Data.",
						},
					},
					"required": ["fieldname"],
				},
			},
			"form_block_id": {
				"type": "string",
				"description": "The ref of the <form> block that holds the inputs (from the page YAML).",
			},
			"force_new": {
				"type": "boolean",
				"description": "Only set true to add a SEPARATE form when the page already has a connected one.",
			},
		},
		"required": ["doctype_name", "fields", "form_block_id"],
	},
	handler=request_connect_form,
)

TOOLS = [connect_form_tool]
