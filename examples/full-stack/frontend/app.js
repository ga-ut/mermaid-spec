const columns = [
  { state: "Backlog", label: "Backlog", action: "start", actionLabel: "Start work" },
  { state: "InProgress", label: "In progress", action: "complete", actionLabel: "Mark done" },
  { state: "Done", label: "Done", action: "reopen", actionLabel: "Reopen" },
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

export function createWorkboardClient(fetchRequest = fetch, { actor = "demo-user", baseUrl = "" } = {}) {
  async function request(path, init = {}) {
    const response = await fetchRequest(`${baseUrl}${path}`, {
      ...init,
      headers: { "x-actor-id": actor, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? `Request failed with ${response.status}`);
    return body;
  }
  return {
    list: () => request("/tasks?limit=50"),
    create: (input) => request("/tasks", { method: "POST", body: JSON.stringify(input) }),
    transition: (id, event) => request(`/tasks/${encodeURIComponent(id)}/events`, { method: "POST", body: JSON.stringify({ event, ...(event === "complete" ? { confirmed: true } : {}) }) }),
  };
}

export function renderBoardMarkup(tasks) {
  const grouped = Object.fromEntries(columns.map((column) => [column.state, tasks.filter((task) => task.status === column.state)]));
  const board = columns.map((column, columnIndex) => `
    <section class="lane" style="--lane-index:${columnIndex}" aria-labelledby="lane-${column.state}">
      <header class="lane-heading">
        <h2 id="lane-${column.state}">${column.label}</h2>
        <span>${grouped[column.state].length}</span>
      </header>
      <div class="task-list">
        ${grouped[column.state].map((task) => `
          <article class="task" data-task-id="${escapeHtml(task.id)}">
            <div>
              <h3>${escapeHtml(task.title)}</h3>
              <p>${escapeHtml(task.description)}</p>
            </div>
            <footer>
              <span>${escapeHtml(task.assignee ?? "Unassigned")}</span>
              <button type="button" data-event="${column.action}" data-task="${escapeHtml(task.id)}">${column.actionLabel}</button>
            </footer>
          </article>`).join("") || `<p class="empty">No tasks</p>`}
      </div>
    </section>`).join("");
  return `<div class="board">${board}</div>`;
}
