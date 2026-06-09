Glossary

Goal
The full user-requested outcome created by a /new_goal prompt. A Goal can contain one or more Plans and continues until the original requested outcome is achieved, abandoned, or replaced by a user-approved edit.

Plan
A bounded execution plan inside a Goal. A Plan should do everything the agent can safely do before reaching an Observation Point. A Goal can have multiple Plans over time.

Task
A unit of executable work inside a Plan. A Task is assigned to a Worker and should have clear inputs, expected output, constraints, verification steps, and completion criteria.

Scout
The codebase exploration step. The Scout reads the prompt and relevant files, then creates a ScoutReport that summarizes facts, constraints, risks, existing implementation details, and likely decisions needed before goal or plan creation.

ScoutReport
The file created by the Scout. It records codebase findings, relevant context, constraints, risks, open questions, and source links. Later ScoutReports should link back to earlier ScoutReports and summarize what changed.

Planner
The plan-creation step. The Planner uses the Goal Brief and other approved planning context to create an executable Plan with tasks, dependencies, verification expectations, constraints, and an Observation Point.

Checker
The plan-review step. The Checker reviews a Plan for correctness, feasibility, scope control, missing decisions, unsafe assumptions, missing verification, and alignment with the Goal Brief, Key Decisions, and relevant sources.

Awaiting Approval
State after a Plan is created and the user needs to approve it, edit it, or reject it before execution.

Worker
The execution agent assigned to a Task. The Worker performs the Task.

Reporter
The post-execution agent. The Reporter creates the Plan Report, manual tests, continuation recommendation, and goal-achieved assessment.

GoalSummary
A short summary of the overall Goal, 140 characters max. It appears in user-facing messages and keeps every agent aligned on the same target.

Long Goal Summary
An extended version of the GoalSummary. It explains the Goal in specific, measurable, and attainable terms and is passed to every agent that works on the Goal.

Goal Brief
The goal-owned artifact that summarizes the Goal and guides planning, execution, reporting, and continuation. It replaces GoalRoadmap in the current lightweight design.

Blocked Task
A Task that cannot continue until the user, operator, environment, or another system provides missing information, permission, access, or an external action. A blocked Task should clearly state what is needed to unblock it.

Failed Task
A Task that attempted its work but did not meet its completion criteria. A Failed Task should include evidence of failure, what was tried, and whether retrying, revising the Plan, or asking the user is the correct next step.

Interrupted Task
A Task that stopped because the process, worker, gateway, or environment was interrupted before completion. An Interrupted Task is not the same as a failed Task. It may be resumable if enough state was persisted.

Decision
A user answer to a question OR a decision inferred from:
• /new_goal prompt
• Add Details
• Incorporate Feedback
• Request Edit
• Interviewer answers
• Planner or Checker edit request
• Codebase evidence when the decision is already implied by existing implementation

Key Decision
A Decision is key if all three of these are true:

1. Hard to reverse: the cost of changing your mind later is meaningful
2. Surprising without context: a future reader will wonder "why did they do it this way?"
3. The result of a real trade-off: there were genuine alternatives and one was chosen for specific reasons
   If any of the three is missing, it is not a Key Decision.

Observation Point
A future point in time when results can be observed. Either actions have happened and their result can now be observed, or time has passed changing the result which can be observed. A Plan should end at an Observation Point when the agent cannot safely decide the next Plan without new evidence.

Manual Test
A user-observed or operator-observed test that the agent cannot fully perform on its own. A Manual Test should say exactly what to do, what to observe, and what counts as pass or fail.

Add Details
A user action that adds information to a blocked or paused Goal without changing the Goal’s intent. Add Details should be treated as context for resuming the current Plan, not as a new Goal.

Incorporate Feedback
A user action that asks the system to revise work based on feedback after something has been produced. It can affect a Plan, report, prompt, continuation proposal, or future work.

Request Edit
A user action that asks the system to revise a proposed Plan, prompt, continuation, or output before approval. Request Edit should use the user’s message as edit instructions, not as a verbatim replacement unless the user explicitly says to replace the content.

Sources Section
A section at the bottom of a generated file that links to source documents used to create that file. Each source link should include a short summary of what that source contributed in the context of the current file.

Source Link
A relative link to another file used as context. A Source Link should point to the exact prior artifact, such as a ScoutReport, Goal Brief, Plan Report, Goal Edit, or Interviewer answer.

Continuation
The post-Plan decision about whether the Goal appears achieved or needs another Plan. Continuation should be based on whether the original Goal is achieved, not merely whether the current Plan completed.

Continuation Message
The user-facing message shown when another Plan is recommended or when the user asks to continue the Goal. It should summarize the next Plan, show any decisions needed, and provide buttons to approve, view the prompt, or request an edit.

Proposed Next Plan Prompt
The drafted prompt that will be sent to the Planner if the user approves the continuation. It should be concrete enough to create the next Plan under the same Goal.

Goal Appears Achieved
A Reporter or continuation assessment that the original user-requested Goal appears satisfied based on available evidence. This does not prevent the user from continuing the Goal manually, but it means the system is not recommending another Plan on its own.

Reporting Failed
A post-execution state where the Plan completed, but the Reporter could not create the Plan Report, manual tests, or continuation assessment after fallback attempts. Reporting Failed should not rerun completed Plan steps.

Lesson
A durable learning captured from prior execution, failure, review, or user feedback. Lessons can be used by future Planners, Checkers, Workers, or Reporters when they are relevant to the current Goal or Plan.

Plan Revision
A revision of a Plan before or during approval. Plan Revision is different from Plan number. Plan 2 is a new Plan under the same Goal; revision 2 is an edited version of the same Plan.

Plan Number
The visible sequence number of a Plan within a Goal, such as Plan 1, Plan 2, or Plan 3.

Original Goal Prompt
The first /new_goal prompt that created the Goal.

