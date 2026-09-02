import { createWorkboardClient, renderBoardMarkup } from "./app.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
}

function shell(tasks, message = "Saved locally") {
  const open = tasks.filter((task) => task.status !== "Done").length;
  return `
    <header class="topbar">
      <div class="brand"><span class="brand-mark" aria-hidden="true"></span><strong>Workboard</strong></div>
      <div class="workspace-meta"><span>${open} open</span><span data-status>${escapeHtml(message)}</span></div>
    </header>
    <main>
      <div class="workspace-heading">
        <div><p class="eyebrow">Product workspace</p><h1>Today’s work</h1></div>
        <p>Every move is checked against the same contract used by the API and database.</p>
      </div>
      ${renderBoardMarkup(tasks)}
    </main>
    <form class="composer" data-composer>
      <label><span>New task</span><input name="title" minlength="2" maxlength="80" placeholder="What needs to move?" required></label>
      <label><span>Detail</span><input name="description" maxlength="400" placeholder="Add a useful constraint" required></label>
      <button type="submit">Add to backlog</button>
    </form>`;
}

export async function mountWorkboard(root, client = createWorkboardClient()) {
  async function refresh(message) {
    const { items } = await client.list();
    root.innerHTML = shell(items, message);
    bind();
  }

  function status(message, failed = false) {
    const target = root.querySelector("[data-status]");
    if (target) {
      target.textContent = message;
      target.dataset.failed = String(failed);
    }
  }

  function bind() {
    root.querySelector("[data-composer]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      status("Adding task…");
      try {
        await client.create({ title: form.get("title"), description: form.get("description") });
        await refresh("Task added");
      } catch (cause) {
        status(cause.message, true);
      }
    });
    for (const button of root.querySelectorAll("[data-event]")) {
      button.addEventListener("click", async () => {
        button.disabled = true;
        status("Moving task…");
        try {
          await client.transition(button.dataset.task, button.dataset.event);
          await refresh("Task moved");
        } catch (cause) {
          button.disabled = false;
          status(cause.message, true);
        }
      });
    }
  }

  await refresh();
}

const root = document.querySelector("#app");
if (root) mountWorkboard(root).catch((cause) => { root.innerHTML = `<p class="fatal">${escapeHtml(cause.message)}</p>`; });
