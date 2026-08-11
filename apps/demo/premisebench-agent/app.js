const mutateButton = document.querySelector("#mutateButton");
const mutateButtonLabel = document.querySelector("#mutateButtonLabel");
const demoStatus = document.querySelector("#demoStatus");
const nextStateCard = document.querySelector("#nextStateCard");
const nextStateTitle = document.querySelector("#nextStateTitle");
const nextStateCopy = document.querySelector("#nextStateCopy");
const plainAgentCard = document.querySelector("#plainAgentCard");
const premiseAgentCard = document.querySelector("#premiseAgentCard");
const plainResponse = document.querySelector("#plainResponse");
const premiseResponse = document.querySelector("#premiseResponse");
const plainStatus = document.querySelector("#plainStatus");
const premiseStatus = document.querySelector("#premiseStatus");
const plainAfter = document.querySelector("#plainAfter");
const premiseAfter = document.querySelector("#premiseAfter");
const plainAnswer = document.querySelector("#plainAnswer");
const premiseAnswer = document.querySelector("#premiseAnswer");
const plainResult = document.querySelector("#plainResult");
const premiseResult = document.querySelector("#premiseResult");

let isMutated = false;

function renderDemo() {
  mutateButton.setAttribute("aria-pressed", String(isMutated));
  mutateButtonLabel.textContent = isMutated ? "Repetir la demostración" : "Simular el cambio A → B";
  demoStatus.textContent = isMutated ? "Después del cambio" : "Antes del cambio";

  nextStateCard.classList.toggle("is-live", isMutated);
  nextStateTitle.textContent = isMutated ? "La información actual" : "El cambio todavía no ocurre";
  nextStateCopy.textContent = isMutated
    ? "El estado del pedido ahora es B."
    : "Pulsa el botón para cambiar el estado del pedido.";

  plainAgentCard.classList.toggle("is-stale", isMutated);
  premiseAgentCard.classList.toggle("is-current", isMutated);
  plainResponse.textContent = "A";
  premiseResponse.textContent = isMutated ? "B" : "A";
  plainStatus.textContent = isMutated ? "Se queda con la respuesta anterior." : "Todo coincide por ahora.";
  premiseStatus.textContent = isMutated ? "Detecta el cambio y comprueba el dato nuevo." : "Todo coincide por ahora.";

  plainAfter.textContent = isMutated ? "A" : "Todavía no lo sabe";
  premiseAfter.textContent = isMutated ? "B" : "Todavía no ocurre";
  plainAnswer.textContent = isMutated ? "La respuesta anterior" : "La respuesta anterior";
  premiseAnswer.textContent = isMutated ? "La respuesta actual" : "La respuesta anterior";
  plainResult.textContent = isMutated ? "No coincide" : "Ambos empiezan igual";
  premiseResult.textContent = isMutated ? "Coincide" : "Ambos empiezan igual";

  plainAfter.classList.toggle("is-stale-cell", isMutated);
  plainAnswer.classList.toggle("is-stale-cell", isMutated);
  plainResult.classList.toggle("is-stale-cell", isMutated);
  premiseAfter.classList.toggle("is-current-cell", isMutated);
  premiseAnswer.classList.toggle("is-current-cell", isMutated);
  premiseResult.classList.toggle("is-current-cell", isMutated);
}

mutateButton.addEventListener("click", () => {
  isMutated = !isMutated;
  renderDemo();
});

renderDemo();
