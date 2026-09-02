export const issueLifecycleHandlers = {
  guards: {
    resolutionProvided: (context) => Boolean(context.resolution),
  },
  effects: {
    assignOwner: (context) => ({ ...context, assigned: true }),
    notifyReporter: (context) => ({ ...context, reporterNotified: true }),
    notifyAssignee: (context) => ({ ...context, assigneeNotified: true }),
  },
};

export default { IssueLifecycle: issueLifecycleHandlers };
