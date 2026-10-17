import { createResource } from "frappe-ui";

// the DocTypes the user can point a form's Send to at
const formDoctypes = createResource({
	url: "builder.api.get_form_doctypes",
	cache: "form-doctypes",
});

export { formDoctypes };
