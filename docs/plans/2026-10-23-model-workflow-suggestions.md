# Suggest and add a workflow for a model nothing runs

**Problem.** A file such as `minimax_h3_ref2va_pruned_int8_convrot.safetensors`
showed "Unclassified", "Not supported yet", a paragraph, and no way forward.

**Today.** Families come from filenames and install records; the header probe
(`weights-layout.ts`) only judged layout. The official workflow library could
be imported by an admin from the Workflows sheet, then tested by hand, and an
import never changed an installed model's verdict.

**Change.**
1. Families MiniMax, Qwen-Image, HiDream (filename), and `familyFromWeightKeys`
   (tensor names) filling `models.base_model` when the header is read.
2. `GET /models/:id/workflow-suggestions`: rank library entries by family words
   (`workflow-suggestions.ts`), convert the top six against the machine with the
   model's own file bound in (`rebind.ts`), return up to three that can be added.
3. `POST /models/:id/workflows/add`: import, download other files through the
   model-operation queue, run the test; `GET …/added/:id` reports and advances
   progress; `DELETE` unlinks. Links in `model_added_workflows` (033).
4. A passed test makes the model "Will run" (`addedVerdicts`) and puts its
   family on the Create map (`withLibraryFamilies`).
5. Web: `WorkflowSuggestions` in the Installed drawer and Create's notice.

**Tests.** Ranking against the real 0.11.55 index fixture; route tests with the
library conversion mocked; component tests. Not run on a real GPU machine.

**Later: a Library "Workflows" view** lists `model_added_workflows` joined to
`imported_workflows` and `workflow_backend_tests` (title, model, machine,
test state), with Remove (`DELETE /models/:id/workflows/added/:workflowId`),
Retest (`POST /workflow-library/:id/test`), and admin imports with no model
link (`GET /workflow-library/imports`). It needs one list endpoint over the
links, and custom-node installs, which have no install path yet.
