-- Which workflow template a model runs on, when an operator has chosen one.
--
-- Left alone, a job picks its template by (capability, family) and by which
-- folder the file is in — see workflows/registry.ts and models/workflow-
-- choice.ts. That is right by default and wrong in exactly the cases an
-- operator can see and the code cannot: a checkpoint whose family we inferred
-- badly, a file that the generic graph mangles but a specific one renders, a
-- template being tried out before it becomes the default. A row here pins the
-- choice for one model and one capability; deleting the row returns it to
-- automatic.
--
-- The template id is a string from the registry, not a foreign key: templates
-- live in code and a row naming one that has since been withdrawn simply
-- stops applying (the lookup ignores an id the registry does not know).

CREATE TABLE model_workflows (
  model_id    uuid NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  capability  text NOT NULL CHECK (capability IN ('txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale')),
  template_id text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, capability)
);
