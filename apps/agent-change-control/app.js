const state = { sourceVersion: "v1", observedVersion: "v1", phase: "ready" };
const $ = (id) => document.getElementById(id);

function setStep(name, status, kind = "muted") {
  const item = document.querySelector(`[data-step="${name}"]`);
  item.classList.toggle("active", status !== "Waiting");
  item.classList.toggle("complete", status === "Done" || status === "Blocked" || status === "Committed");
  const pill = $(`${name}-status`);
  pill.textContent = status === "Done" ? "Done" : status;
  pill.className = `status-pill ${kind}`;
}

function render() {
  $("source-version").textContent = state.sourceVersion;
  $("hero-status").textContent = state.phase === "blocked" ? "Source changed to v2 — old plan blocked" : state.phase === "committed" ? "Fresh action committed against v2" : "Source is ready at v1";
  if (state.phase === "ready") {
    $("decision").dataset.state = "ready"; $("decision-icon").textContent = "✓"; $("decision-title").textContent = "Safe to prepare"; $("decision-copy").textContent = "The plan matches the source.";
    $("change-button").disabled = false; $("commit-button").disabled = true;
    setStep("observe", "Done", "green"); setStep("change", "Waiting"); setStep("guard", "Waiting"); setStep("commit", "Waiting");
  } else if (state.phase === "blocked") {
    $("decision").dataset.state = "blocked"; $("decision-icon").textContent = "!"; $("decision-title").textContent = "STALE_SOURCE · action blocked"; $("decision-copy").textContent = "The source is v2, but this plan was made from v1.";
    $("change-button").disabled = true; $("commit-button").disabled = false;
    setStep("observe", "Done", "green"); setStep("change", "Changed · v2", "amber"); setStep("guard", "Blocked", "red"); setStep("commit", "Waiting");
  } else {
    $("decision").dataset.state = "committed"; $("decision-icon").textContent = "✓"; $("decision-title").textContent = "Committed safely at v2"; $("decision-copy").textContent = "The action used fresh evidence after revalidation.";
    $("change-button").disabled = true; $("commit-button").disabled = true;
    setStep("observe", "Done", "green"); setStep("change", "Changed · v2", "amber"); setStep("guard", "Blocked", "red"); setStep("commit", "Committed", "green");
  }
}

$("change-button").addEventListener("click", () => { state.sourceVersion = "v2"; state.phase = "blocked"; render(); });
$("commit-button").addEventListener("click", () => { state.observedVersion = state.sourceVersion; state.phase = "committed"; render(); });
$("reset-button").addEventListener("click", () => { state.sourceVersion = "v1"; state.observedVersion = "v1"; state.phase = "ready"; render(); });
render();
