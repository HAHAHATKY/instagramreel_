const video = document.querySelector("#camera");
const preview = document.querySelector("#preview");
const previewLabel = document.querySelector("#preview-label");
const startButton = document.querySelector("#start-camera");
const sendButton = document.querySelector("#send-photo");
const stopButton = document.querySelector("#stop-camera");
const status = document.querySelector("#status");

let stream = null;
let sending = false;

function showStatus(message, state = "") {
  status.textContent = message;
  status.dataset.state = state;
}

function setCameraActive(active) {
  preview.classList.toggle("is-live", active);
  previewLabel.hidden = !active;
  sendButton.disabled = !active || sending;
  startButton.disabled = active || sending;
  stopButton.hidden = !active;
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  video.srcObject = null;
  setCameraActive(false);
}

startButton.addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    showStatus("Tento prohlížeč nepodporuje přístup ke kameře. Otevři stránku v aktuálním prohlížeči na HTTPS nebo localhost.", "error");
    return;
  }

  startButton.disabled = true;
  showStatus("Čekáme na povolení přístupu ke kameře. Povolení můžeš kdykoliv odmítnout.");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user" },
    });
    video.srcObject = stream;
    await video.play();
    setCameraActive(true);
    showStatus("Kamera je připravena. Zkontroluj náhled; fotka se pořídí až po klepnutí na tlačítko odeslání.");
  } catch (error) {
    stopCamera();
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      showStatus("Přístup ke kameře nebyl povolen. Povol ho v nastavení prohlížeče a zkus to znovu.", "error");
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      showStatus("Nenašli jsme kameru. Připoj kameru a zkus to znovu.", "error");
    } else {
      showStatus("Kameru se nepodařilo spustit. Zkontroluj, zda ji nepoužívá jiná aplikace, a zkus to znovu.", "error");
    }
    startButton.disabled = false;
  }
});

stopButton.addEventListener("click", () => {
  stopCamera();
  showStatus("Kamera je vypnutá. Pro nový náhled ji můžeš znovu zapnout.");
});

sendButton.addEventListener("click", async () => {
  if (!stream || sending) return;
  if (!video.videoWidth || !video.videoHeight) {
    showStatus("Náhled kamery ještě není připravený. Zkus to prosím za chvíli.", "error");
    return;
  }

  const canvas = document.createElement("canvas");
  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

  sending = true;
  sendButton.disabled = true;
  startButton.disabled = true;
  showStatus("Fotografie se odesílá do Telegramu…");

  try {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((image) => {
        if (image) resolve(image);
        else reject(new Error("Nepodařilo se připravit fotografii."));
      }, "image/jpeg", 0.86);
    });
    const form = new FormData();
    form.append("photo", blob, "selfie.jpg");
    const response = await fetch("/api/send-photo", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Fotografii se nepodařilo odeslat.");
    showStatus("Hotovo — fotografie byla odeslána do Telegramu.", "success");
  } catch (error) {
    showStatus(error.message || "Fotografii se nepodařilo odeslat. Zkontroluj připojení a zkus to znovu.", "error");
  } finally {
    sending = false;
    sendButton.disabled = !stream;
    startButton.disabled = Boolean(stream);
  }
});
