import json

import frappe
import requests
from frappe import _
from frappe.utils import cstr, escape_html, validate_email_address
from frappe.utils.password import decrypt, encrypt

MAX_FIELDS = 50
MAX_VALUE_LENGTH = 5000


def seal_destinations(destinations: str) -> str:
	return encrypt(destinations)


def unseal_destinations(sealed: str) -> list[dict]:
	try:
		destinations = json.loads(decrypt(sealed))
	except (frappe.ValidationError, ValueError):
		# decrypt's message is about site_config, which means nothing to a visitor
		frappe.clear_messages()
		frappe.throw(_("This form can't be submitted."), frappe.PermissionError)
	return [d for d in destinations if isinstance(d, dict)] if isinstance(destinations, list) else []


class FormSubmission:
	"""A visitor's submission of a published form. Its destinations arrive sealed by the
	page render, so the visitor can neither read nor change where it is delivered."""

	def __init__(self, sealed_destinations: str, data: dict, path: str):
		self.destinations = unseal_destinations(sealed_destinations)
		self.data = {
			key[:140]: cstr(value)[:MAX_VALUE_LENGTH]
			for key, value in list(data.items())[:MAX_FIELDS]
			if key
		}
		self.path = path

	def deliver(self):
		if recipients := [e for e in self.get_destinations("email") if validate_email_address(e)]:
			self.send_email(recipients)
		for url in self.get_destinations("webhook"):
			frappe.enqueue(post_to_webhook, url=url, data=self.data, enqueue_after_commit=True)

	def get_destinations(self, destination_type: str) -> list[str]:
		values = (
			cstr(d.get("value")).strip() for d in self.destinations if d.get("type") == destination_type
		)
		return [value for value in values if value]

	def send_email(self, recipients: list[str]):
		try:
			frappe.sendmail(
				recipients=recipients,
				subject=_("New form submission on {0}").format(self.path),
				message=self.get_message(),
			)
		except frappe.OutgoingEmailError:
			# the visitor can't fix the site's email setup, so the admin finds it in Error Log instead
			frappe.clear_messages()
			frappe.log_error(_("Form submission on {0} not emailed").format(self.path))

	def get_message(self) -> str:
		rows = "".join(
			f"<tr><td><b>{escape_html(key)}</b></td><td>{escape_html(value)}</td></tr>"
			for key, value in self.data.items()
		)
		return f"<table>{rows}</table>"


def post_to_webhook(url: str, data: dict):
	from builder.api import assert_not_private_url

	assert_not_private_url(url)
	requests.post(url, json=data, timeout=10).raise_for_status()
