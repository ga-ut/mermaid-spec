export const taskLifecycleHandlers = {
  guards: {
    workConfirmed: (context) => context.confirmed === true,
  },
  effects: {
    markStarted: (context) => ({ ...context, started: true }),
    markCompleted: (context) => ({ ...context, completed: true }),
    markReopened: (context) => ({ ...context, reopened: true }),
  },
};

export default { TaskLifecycle: taskLifecycleHandlers };
