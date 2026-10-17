import json
from types import SimpleNamespace
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from builder.ai.agent import pending
from builder.ai.agent.tools.forms import request_connect_form
from builder.ai.agent.tree import WorkingTree


class TestRequestConfirmation(FrappeTestCase):
	def test_persists_the_turns_steps_and_trace_on_the_card(self):
		session = frappe.get_doc({"doctype": "Builder AI Session", "session_user": "Administrator"}).insert()
		ctx = SimpleNamespace(
			session_id=session.name,
			timeline=lambda: [{"id": 0, "kind": "tool", "tool": "generate_page", "status": "done"}],
			trace=[{"round": 0, "tools": [{"name": "generate_page", "args": "{}"}], "text": ""}],
			loop_model="openrouter/test-model",
			emit=lambda *args, **kwargs: None,
		)

		pending.request_confirmation(ctx, "create_doctype", "Create it?", {"name": "X", "fields": [1]})

		message = frappe.get_all(
			"Builder AI Message", filters={"session": session.name}, fields=["status", "metadata_json"]
		)[0]
		meta = json.loads(message.metadata_json)
		self.assertEqual(message.status, "pending_action")
		self.assertEqual(meta["steps"][0]["tool"], "generate_page")
		self.assertEqual(meta["debug"]["trace"][0]["tools"][0]["name"], "generate_page")


def form_page_root(form_attributes: dict, input_attributes: dict) -> dict:
	return {
		"blockId": "root",
		"element": "body",
		"children": [
			{
				"blockId": "signup",
				"element": "form",
				"attributes": form_attributes,
				"children": [{"blockId": "email", "element": "input", "attributes": input_attributes}],
			}
		],
	}


class TestConnectForm(FrappeTestCase):
	def request(self, root: dict, fieldnames: list[str], form_block_id="signup") -> str | None:
		ctx = SimpleNamespace(page_id="page-without-a-doc", tree=WorkingTree(root))
		args = {
			"doctype_name": "Signup Submission",
			"fields": [{"fieldname": fieldname} for fieldname in fieldnames],
			"form_block_id": form_block_id,
		}
		return request_connect_form(ctx, args)

	def test_declines_until_each_field_has_a_named_input(self):
		declined = self.request(form_page_root({}, {"type": "email"}), ["email"])

		self.assertIn("no input in the form is named email", declined)

	def test_declines_a_block_that_is_not_a_form(self):
		root = form_page_root({}, {"name": "email"})
		root["children"][0]["element"] = "div"

		self.assertIn("must be a <form> block", self.request(root, ["email"]))

	def test_declines_a_reserved_fieldname(self):
		self.assertIn("can't be fieldnames", self.request(form_page_root({}, {"name": "name"}), ["name"]))

	def test_points_the_form_at_the_new_doctype_and_keeps_its_destinations(self):
		email = {"type": "email", "value": "owner@example.com"}
		root = form_page_root({"data-send-to": json.dumps([email])}, {"name": "email"})
		page = frappe.get_doc(
			{"doctype": "Builder Page", "page_title": "Signup", "draft_blocks": json.dumps([root])}
		).insert()
		payload = {
			"doctype_name": "Signup Submission",
			"fields": [{"fieldname": "email", "label": "Email", "fieldtype": "Data"}],
			"page_id": page.name,
			"form_block_id": "signup",
		}

		with patch("builder.ai.agent.pending.create_form_doctype") as create_form_doctype:
			result = pending.apply_pending_action("connect_form", payload)

		create_form_doctype.assert_called_once()
		form = json.loads(frappe.db.get_value("Builder Page", page.name, "draft_blocks"))[0]["children"][0]
		send_to = {**form.get("attributes", {}), **form.get("customAttributes", {})}["data-send-to"]
		self.assertEqual(json.loads(send_to), [email, {"type": "doctype", "value": "Signup Submission"}])
		self.assertEqual(result["client_ops"][0]["args"]["attributes"]["data-send-to"], send_to)
		self.assertIn("/app/signup-submission", result["message"])
