"""Confirm-gating for sensitive agent actions.

A sensitive tool NEVER mutates directly. It calls `request_confirmation`, which
persists a pending-action message and emits a clarify event carrying the payload,
then ends the turn (the tool is `side="terminal"`). The frontend renders an
Apply/Skip card; on Apply it calls the `confirm_pending_settings` endpoint, which
loads the stored payload and runs `apply_pending_action`. So every privileged write
(global settings, home page, new doctype, sample data, publish) is user-triggered —
the model can only *propose*.
"""

import frappe

from builder.ai import page_writer
from builder.ai.agent.tree import WorkingTree
from builder.ai.session import AISession
from builder.form_doctype import create_form_doctype
from builder.form_submission import parse_destinations
from builder.utils import compact_json

# Sensitive action kinds the confirm card understands. Kept explicit so an unknown
# kind can never be applied.
KINDS = {
	"home_page",
	"global_settings",
	"create_doctype",
	"seed_sample_data",
	"connect_form",
}

GLOBAL_SETTING_FIELDS = {"script", "style", "head_html", "body_html"}


def request_confirmation(ctx, kind: str, summary: str, payload: dict) -> None:
	"""Persist + emit a pending sensitive action, then end the turn without mutating."""
	metadata = {"status": "pending_action", "kind": kind, "payload": payload}
	# The card is this turn's ONLY persisted message — without the timeline and
	# trace, everything the turn did before proposing (a whole page build) is
	# invisible on reload and undebuggable after the fact.
	if timeline := ctx.timeline():
		metadata["steps"] = timeline
	if ctx.trace:
		metadata["debug"] = {"loopModel": ctx.loop_model, "trace": ctx.trace}
	message_id = AISession.try_append_message(
		ctx.session_id,
		"assistant",
		summary,
		message_type="clarification",
		task_type="agent",
		metadata=metadata,
	)
	ctx.emit(
		"clarify",
		question=summary,
		options=["Apply", "Skip"],
		pending_action={"kind": kind, "payload": payload},
		message_id=message_id,
		after_commit=True,
	)


def apply_pending_action(kind: str, payload: dict) -> dict:
	"""Run the real mutation for a confirmed action. Called ONLY from the confirm
	endpoint (user-triggered). Returns a short human summary of what happened as
	`message`, and the edits it made to the page as `client_ops`, for the open
	canvas to apply too."""
	if kind not in KINDS:
		frappe.throw(frappe._("Unknown pending action: {0}").format(kind))
	payload = payload or {}
	result = {
		"home_page": apply_home_page,
		"global_settings": apply_global_settings,
		"create_doctype": apply_create_doctype,
		"seed_sample_data": apply_seed_sample_data,
		"connect_form": apply_connect_form,
	}[kind](payload)
	return result if isinstance(result, dict) else {"message": result, "client_ops": []}


def apply_home_page(payload: dict) -> str:
	route = (payload.get("route") or "").strip().lstrip("/")
	frappe.db.set_single_value("Builder Settings", "home_page", route)
	return frappe._("Home page set to /{0}").format(route)


def apply_global_settings(payload: dict) -> str:
	settings = frappe.get_single("Builder Settings")
	changed = []
	for field in GLOBAL_SETTING_FIELDS:
		if field in payload and payload[field] is not None:
			settings.set(field, payload[field])
			changed.append(field)
	if changed:
		settings.save(ignore_permissions=True)
	return frappe._("Updated global settings: {0}").format(", ".join(changed) or "nothing")


def apply_create_doctype(payload: dict) -> str:
	"""Create a Custom DocType (custom=1, created at runtime — no code files / app
	migration) with Guest read so public pages can query it."""
	name = (payload.get("name") or "").strip()
	if not name:
		frappe.throw(frappe._("Doctype name is required"))
	if frappe.db.exists("DocType", name):
		return frappe._("DocType {0} already exists").format(name)

	fields = []
	for f in payload.get("fields") or []:
		fieldname = (f.get("fieldname") or "").strip()
		if not fieldname:
			continue
		fields.append(
			{
				"fieldname": fieldname,
				"label": f.get("label") or fieldname.replace("_", " ").title(),
				"fieldtype": f.get("fieldtype") or "Data",
				"options": f.get("options"),
				"in_list_view": 1,
			}
		)
	if not fields:
		frappe.throw(frappe._("At least one field is required"))

	frappe.get_doc(
		{
			"doctype": "DocType",
			"name": name,
			"module": "Builder",
			"custom": 1,
			"naming_rule": "Random",
			"fields": fields,
			"permissions": [
				{"role": "System Manager", "read": 1, "write": 1, "create": 1, "delete": 1},
				# Public website pages read data as Guest.
				{"role": "Guest", "read": 1},
			],
		}
	).insert(ignore_permissions=True)
	return frappe._("Created DocType {0} with {1} field(s)").format(name, len(fields))


def apply_seed_sample_data(payload: dict) -> str:
	doctype = (payload.get("doctype") or "").strip()
	rows = payload.get("rows") or []
	if not doctype or not frappe.db.exists("DocType", doctype):
		frappe.throw(frappe._("DocType {0} does not exist").format(doctype))
	created = 0
	for row in rows:
		if not isinstance(row, dict):
			continue
		frappe.get_doc({"doctype": doctype, **row}).insert(ignore_permissions=True)
		created += 1
	return frappe._("Seeded {0} sample record(s) into {1}").format(created, doctype)


def apply_connect_form(payload: dict) -> dict:
	"""Wire a page form to real data: a private submission DocType (reused if it
	exists) and the form's Send to pointed at it. Returns the Desk link to the
	entries, and the same edit for the open canvas to apply."""
	from builder.ai.agent.tools.forms import desk_slug

	doctype = (payload.get("doctype_name") or "").strip()
	fields = payload.get("fields") or []
	page_id = (payload.get("page_id") or "").strip()
	form_block_id = (payload.get("form_block_id") or "").strip()
	if not doctype or not fields or not page_id or not form_block_id:
		frappe.throw(frappe._("connect_form needs a doctype, fields, a page and its form"))

	# confirming is the user's go-ahead, as for create_doctype; submissions need no guest permission
	if not frappe.db.exists("DocType", doctype):
		create_form_doctype(doctype, fields, ignore_permissions=True)
	op = point_form_at(page_id, form_block_id, doctype)
	message = frappe._(
		"Form connected. Submissions save to '{0}'. View them in Desk: [/app/{1}](/app/{1})"
	).format(doctype, desk_slug(doctype))
	return {"message": message, "client_ops": [op]}


def point_form_at(page_id: str, form_block_id: str, doctype: str) -> dict:
	"""Add the DocType to the form's Send to in the page draft, keeping its other
	destinations. Returns the edit as a client op, for the canvas to stay in step."""
	tree = WorkingTree(page_writer.load_page_root(page_id))
	form = tree.resolve(form_block_id)
	if form is None:
		frappe.throw(frappe._("The form is no longer on the page"))
	attributes = {**(form.get("attributes") or {}), **(form.get("customAttributes") or {})}
	destinations = [
		d
		for d in parse_destinations(attributes.get("data-send-to"))
		if not (d.get("type") == "doctype" and d.get("value") == doctype)
	]
	destinations.append({"type": "doctype", "value": doctype})
	op = {
		"tool_name": "update_block",
		"args": {"block_id": form_block_id, "attributes": {"data-send-to": compact_json(destinations)}},
	}
	tree.apply(op["tool_name"], op["args"])
	page_writer.save_draft_blocks(page_id, tree.root)
	return op
