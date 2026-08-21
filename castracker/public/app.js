const state = {
  status: null,
  podcasts: [],
  jobs: [],
  view: "library",
  currentPodcastId: null,
  inspection: null,
  selectedEpisodes: new Set(),
  episodeQuery: "",
  episodeFilter: "all",
  removingId: null,
  polling: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body
      ? { "content-type": "application/json", ...(options.headers || {}) }
      : options.headers,
  });
  const type = response.headers.get("content-type") || "";
  const value = type.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    throw new Error(
      value?.error || value || `Request failed (${response.status})`,
    );
  }
  return value;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[character]);
}

function sourceName(sourceType) {
  return sourceType === "youtube"
    ? "YouTube"
    : sourceType === "rss"
    ? "RSS feed"
    : "Media";
}

function formatBytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${
    units[exponent]
  }`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Duration unknown";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes} min`;
}

function formatDate(value) {
  if (!value) return "Undated";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Undated";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function relativeTime(value) {
  if (!value) return "";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  if (Math.abs(seconds) < 3600) {
    return formatter.format(Math.round(seconds / 60), "minute");
  }
  if (Math.abs(seconds) < 86400) {
    return formatter.format(Math.round(seconds / 3600), "hour");
  }
  return formatter.format(Math.round(seconds / 86400), "day");
}

function coverMarkup(podcast, className = "") {
  const local = podcast.coverFile
    ? `/api/podcasts/${encodeURIComponent(podcast.id)}/artwork`
    : null;
  const source = local || podcast.coverUrl;
  if (source) {
    return `<img class="${className}" src="${
      escapeHtml(source)
    }" alt="" loading="lazy">`;
  }
  return `<div class="cover-fallback ${className}">${
    escapeHtml((podcast.title || "P").slice(0, 1).toUpperCase())
  }</div>`;
}

function toast(message, kind = "success") {
  const item = document.createElement("div");
  item.className = `toast ${kind === "error" ? "error" : ""}`;
  item.innerHTML = `<strong>${
    kind === "error" ? "Couldn’t finish." : "Done."
  }</strong>${escapeHtml(message)}`;
  $("#toast-stack").append(item);
  setTimeout(() => item.remove(), 5500);
}

function setView(view) {
  state.view = view;
  $$(".view").forEach((element) =>
    element.classList.toggle("active", element.id === `${view}-view`)
  );
  $$(".nav-item").forEach((element) =>
    element.classList.toggle("active", element.dataset.view === view)
  );
  const labels = {
    library: ["YOUR COLLECTION", "Podcast library"],
    queue: ["BACKGROUND WORK", "Activity"],
    settings: ["LOCAL CONFIGURATION", "Settings"],
    detail: ["PODCAST", "Series details"],
  };
  $("#page-eyebrow").textContent = labels[view][0];
  $("#page-title").textContent = labels[view][1];
  $("#global-search-wrap").hidden = view !== "library";
  if (view !== "detail") state.currentPodcastId = null;
}

function renderStats() {
  const stats = state.status?.stats ||
    { podcasts: 0, episodes: 0, downloaded: 0, bytes: 0 };
  $("#stats-row").innerHTML = [
    [stats.podcasts, "Podcasts"],
    [stats.episodes, "Known episodes"],
    [stats.downloaded, "Downloaded"],
    [formatBytes(stats.bytes), "On disk"],
  ].map(([value, label]) =>
    `<div class="stat"><small>${label}</small><strong>${
      escapeHtml(value)
    }</strong></div>`
  ).join("");
}

function renderLibrary() {
  renderStats();
  const query = $("#global-search").value.trim().toLowerCase();
  const podcasts = state.podcasts.filter((podcast) =>
    `${podcast.title} ${podcast.author}`.toLowerCase().includes(query)
  );
  $("#empty-library").hidden = state.podcasts.length !== 0;
  $("#podcast-grid").hidden = state.podcasts.length === 0;
  $("#library-subtitle").textContent = query
    ? `${podcasts.length} matching podcast${podcasts.length === 1 ? "" : "s"}`
    : "Your managed AudioBookShelf collection";
  $("#podcast-grid").innerHTML = podcasts.map((podcast) => {
    const total = podcast.episodes.length;
    const downloaded = podcast.downloadedCount || 0;
    const progress = total ? Math.round(downloaded / total * 100) : 0;
    return `<article class="podcast-card" data-podcast-id="${
      escapeHtml(podcast.id)
    }" tabindex="0" role="button">
      <div class="cover-shell">
        ${coverMarkup(podcast)}
        <span class="card-badge">${
      escapeHtml(sourceName(podcast.sourceType))
    }</span>
        <progress class="card-progress" max="100" value="${progress}" aria-label="${progress}% downloaded"></progress>
      </div>
      <div class="card-copy">
        <h3>${escapeHtml(podcast.title)}</h3>
        <p>${escapeHtml(podcast.author || "Unknown publisher")}</p>
        <div class="card-meta"><span>${downloaded} downloaded</span><i></i><span>${total} episodes</span></div>
      </div>
    </article>`;
  }).join("") || (state.podcasts.length
    ? `<div class="empty-state"><h2>No matches</h2><p>Try a different title or publisher.</p></div>`
    : "");
}

function renderJobs() {
  const active =
    state.jobs.filter((job) =>
      job.status === "queued" || job.status === "running"
    ).length;
  const badge = $("#active-job-badge");
  badge.hidden = active === 0;
  badge.textContent = String(active);
  $("#jobs-list").innerHTML = state.jobs.length
    ? state.jobs.map((job) => {
      const icon = job.status === "completed"
        ? "✓"
        : job.status === "failed"
        ? "!"
        : job.type === "download"
        ? "↓"
        : job.type === "refresh"
        ? "↻"
        : "⌁";
      const when = job.finishedAt || job.startedAt || job.createdAt;
      const podcast = state.podcasts.find((item) => item.id === job.podcastId);
      const savedFailures = Array.isArray(job.failures) ? job.failures : [];
      const legacyFailures = savedFailures.length || !podcast
        ? []
        : podcast.episodes.filter((episode) =>
          job.episodeIds.includes(episode.id) &&
          (episode.status === "failed" || episode.status === "unavailable") &&
          episode.error
        ).map((episode) => ({
          episodeId: episode.id,
          title: episode.title,
          error: episode.error,
          unavailable: episode.status === "unavailable",
        }));
      const failures = savedFailures.length ? savedFailures : legacyFailures;
      const failureMarkup = job.type === "download" && failures.length
        ? `<div class="job-diagnostics"><strong>${
          savedFailures.length ? "Failure details" : "Current failure details"
        }</strong>${
          failures.slice(0, 3).map((failure) =>
            `<div class="job-diagnostic"><span>${
              escapeHtml(failure.title)
            }</span><code>${escapeHtml(failure.error)}</code></div>`
          ).join("")
        }${
          failures.length > 3
            ? `<small>+${failures.length - 3} more affected episode${
              failures.length - 3 === 1 ? "" : "s"
            }</small>`
            : ""
        }${
          podcast
            ? `<button class="text-button job-show-failures" data-podcast-id="${
              escapeHtml(podcast.id)
            }">View affected episodes</button>`
            : ""
        }</div>`
        : "";
      return `<article class="job-card ${escapeHtml(job.status)}">
      <div class="job-icon">${icon}</div>
      <div class="job-copy"><strong>${
        escapeHtml(job.title)
      }</strong><p title="${escapeHtml(job.error || job.message)}">${
        escapeHtml(job.error || job.message)
      }</p>
        ${
        (job.status === "running" || job.status === "queued")
          ? `<progress class="progress-track" max="100" value="${
            Math.max(2, Math.round(job.progress * 100))
          }" aria-label="Download progress"></progress>`
          : ""
      }
        ${failureMarkup}
       </div>
      <div class="job-time">${escapeHtml(relativeTime(when))}</div>
    </article>`;
    }).join("")
    : `<div class="empty-state"><div class="empty-orbit"><div>⇣</div></div><h2>Nothing in the queue</h2><p>Downloads and metadata jobs will appear here.</p></div>`;
}

function toolCard(name, tool, description, installButton = "") {
  const available = tool?.available;
  return `<div class="settings-icon">${
    available ? "✓" : "…"
  }</div><div class="settings-copy">
    <span class="status-pill ${available ? "" : "missing"}">${
    available ? "READY" : "NOT FOUND"
  }</span>
    <h3>${escapeHtml(name)}</h3><p>${escapeHtml(description)}</p>
    ${installButton}
  </div>`;
}

function renderSettings() {
  if (!state.status) return;
  const { tools, settings, library } = state.status;
  if (document.activeElement !== $("#library-path")) {
    $("#library-path").value = settings.libraryPath;
  }
  $("#library-path-status").innerHTML = library?.available
    ? `<span class="status-pill">AVAILABLE</span><span>Local folders and mounted network shares are supported.</span>`
    : `<span class="status-pill missing">UNAVAILABLE</span><span>${
      escapeHtml(
        library?.error || "The configured library folder cannot be reached.",
      )
    }</span>`;
  const mediaReady = tools.ytDlp.available && tools.deno.available &&
    tools.ffmpeg.available;
  const ready = mediaReady && library?.available !== false;
  $("#tool-health").innerHTML =
    `<small>SYSTEM</small><div><i class="health-dot ${
      ready ? "" : "warn"
    }"></i><span>${
      ready
        ? "Media tools ready"
        : library?.available === false
        ? "Library folder unavailable"
        : !tools.ffmpeg.available
        ? "FFmpeg setup needed"
        : !tools.ytDlp.available
        ? "yt-dlp needed for media sources"
        : "Deno runtime not detected"
    }</span></div>`;
  const installing = state.jobs.some((job) =>
    job.type === "tool-install" && ["queued", "running"].includes(job.status)
  );
  const automaticInstall = state.status.capabilities
    ?.automaticFfmpegInstall === true;
  const install = tools.ffmpeg.available
    ? ""
    : automaticInstall
    ? `<button class="button secondary" id="install-ffmpeg" ${
      installing ? "disabled" : ""
    }>${installing ? "Installing…" : "Install FFmpeg"}</button>`
    : `<p class="tool-hint">Install FFmpeg with your system package manager, then restart Castracker.</p>`;
  $("#ffmpeg-card").innerHTML = toolCard(
    "FFmpeg",
    tools.ffmpeg,
    "Converts quality presets, embeds cover art, and writes AudioBookShelf episode tags.",
    install,
  );
  $("#ytdlp-card").innerHTML = toolCard(
    "yt-dlp",
    tools.ytDlp,
    "Reads YouTube playlists and other supported public media sources.",
  );
}

function filteredEpisodes(podcast) {
  const query = state.episodeQuery.toLowerCase();
  return podcast.episodes.filter((episode) => {
    const matchesText = `${episode.title} ${episode.description}`.toLowerCase()
      .includes(query);
    const matchesStatus = state.episodeFilter === "all" ||
      (state.episodeFilter === "issues"
        ? episode.status === "failed" || episode.status === "unavailable"
        : episode.status === state.episodeFilter);
    return matchesText && matchesStatus;
  });
}

function episodeLabel(episode, index) {
  if (episode.season && episode.episode) {
    return `S${String(episode.season).padStart(2, "0")}E${
      String(episode.episode).padStart(2, "0")
    }`;
  }
  if (episode.episode) return `E${episode.episode}`;
  return String(index + 1).padStart(2, "0");
}

function isSelectableEpisode(episode) {
  return episode.status === "available" || episode.status === "failed";
}

function selectionActionLabel(episodes, noun) {
  const allSelected = episodes.length > 0 &&
    episodes.every((episode) => state.selectedEpisodes.has(episode.id));
  return `${allSelected ? "Deselect" : "Select"} ${noun}`;
}

function updateSelectionControls(podcast) {
  const allSelectable = podcast.episodes.filter(isSelectableEpisode);
  const visibleSelectable = filteredEpisodes(podcast).filter(
    isSelectableEpisode,
  );
  const selectAll = $("[data-action='select-all']", $("#podcast-detail"));
  const selectVisible = $(
    "[data-action='select-visible']",
    $("#podcast-detail"),
  );
  selectAll.textContent = selectionActionLabel(allSelectable, "all");
  selectAll.disabled = allSelectable.length === 0;
  selectVisible.textContent = selectionActionLabel(
    visibleSelectable,
    "visible",
  );
  selectVisible.disabled = visibleSelectable.length === 0;
}

function renderDetail() {
  const podcast = state.podcasts.find((item) =>
    item.id === state.currentPodcastId
  );
  if (!podcast) {
    setView("library");
    renderLibrary();
    return;
  }
  const episodes = filteredEpisodes(podcast);
  const allSelectable = podcast.episodes.filter(isSelectableEpisode);
  const visibleSelectable = episodes.filter(isSelectableEpisode);
  const downloaded = podcast.downloadedCount || 0;
  const mediaReady = state.status?.tools?.ffmpeg?.available === true;
  $("#page-title").textContent = podcast.title;
  $("#podcast-detail").innerHTML = `<div class="detail-hero">
    <div class="detail-cover">${coverMarkup(podcast)}</div>
    <div class="detail-copy"><span class="source-badge">${
    escapeHtml(sourceName(podcast.sourceType))
  }</span>
      <h2>${escapeHtml(podcast.title)}</h2><div class="author">${
    escapeHtml(podcast.author || "Unknown publisher")
  }</div>
      <div class="description">${
    escapeHtml(podcast.description || "No description supplied by this source.")
  }</div>
      <div class="detail-actions">
        <button class="button primary" data-action="download-selected" ${
    state.selectedEpisodes.size && mediaReady ? "" : "disabled"
  } title="${
    mediaReady
      ? "Download selected episodes"
      : "Install FFmpeg in Settings first"
  }">Download selected (${state.selectedEpisodes.size})</button>
        <button class="button secondary" data-action="refresh">Refresh source</button>
        <button class="button ghost" data-action="retag" ${
    downloaded && mediaReady ? "" : "disabled"
  }>Rewrite tags</button>
      </div>
    </div>
  </div>
  <div class="detail-layout">
    <section class="episode-panel"><div class="panel-head"><div><h3>Episodes</h3><p>${downloaded} of ${podcast.episodes.length} downloaded · ${
    formatBytes(podcast.libraryBytes)
  }</p></div><div class="selection-actions">
        <button class="text-button" data-action="select-all" ${
    allSelectable.length ? "" : "disabled"
  }>${selectionActionLabel(allSelectable, "all")}</button>
        <button class="text-button" data-action="select-visible" ${
    visibleSelectable.length ? "" : "disabled"
  }>${selectionActionLabel(visibleSelectable, "visible")}</button>
      </div></div>
      <div class="episode-tools"><input id="episode-search" type="search" value="${
    escapeHtml(state.episodeQuery)
  }" placeholder="Search episodes"><select id="episode-filter">
        ${
    [
      ["all", "All"],
      ["available", "Available"],
      ["queued", "Queued"],
      ["downloading", "Downloading"],
      ["downloaded", "Downloaded"],
      ["issues", "Needs attention"],
      ["failed", "Failed"],
      ["unavailable", "Unavailable"],
    ].map(([value, label]) =>
      `<option value="${value}" ${
        state.episodeFilter === value ? "selected" : ""
      }>${label}</option>`
    ).join("")
  }
      </select></div>
      <div class="episode-list">${
    episodes.length
      ? episodes.map((episode) => {
        const originalIndex = podcast.episodes.findIndex((item) =>
          item.id === episode.id
        );
        const selectable = isSelectableEpisode(episode);
        return `<div class="episode-row"><input class="episode-check" type="checkbox" data-episode-id="${
          escapeHtml(episode.id)
        }" ${state.selectedEpisodes.has(episode.id) ? "checked" : ""} ${
          selectable ? "" : "disabled"
        }>
          <div class="episode-number">${
          episodeLabel(episode, originalIndex)
        }</div>
          <div class="episode-copy"><strong title="${
          escapeHtml(episode.title)
        }">${escapeHtml(episode.title)}</strong><span>${
          escapeHtml(formatDate(episode.publishedAt))
        } · ${escapeHtml(formatDuration(episode.durationSeconds))}${
          episode.fileSize ? ` · ${formatBytes(episode.fileSize)}` : ""
        }</span>${
          (episode.status === "failed" || episode.status === "unavailable") &&
            episode.error
            ? `<span class="episode-error">${escapeHtml(episode.error)}</span>`
            : ""
        }</div>
          ${
          episode.status === "downloaded"
            ? `<audio controls preload="none" src="/api/podcasts/${
              encodeURIComponent(podcast.id)
            }/episodes/${encodeURIComponent(episode.id)}/audio"></audio>`
            : `<span class="episode-state ${
              escapeHtml(episode.status)
            }" title="${escapeHtml(episode.error || "")}">${
              escapeHtml(episode.status)
            }</span>`
        }
        </div>`;
      }).join("")
      : `<div class="empty-state"><h2>No episodes found</h2><p>Change the search or status filter.</p></div>`
  }</div>
    </section>
    <aside class="metadata-panel"><div class="panel-head"><div><h3>Library metadata</h3><p>Used in tags and sidecars</p></div></div>
      <form class="metadata-form" id="metadata-form">
        <label><span>Title</span><input name="title" value="${
    escapeHtml(podcast.title)
  }" required></label>
        <label><span>Author / publisher</span><input name="author" value="${
    escapeHtml(podcast.author)
  }"></label>
        <label><span>Genres</span><input name="genres" value="${
    escapeHtml(podcast.genres.join(", "))
  }" placeholder="Education, Language"></label>
        <label><span>Language</span><input name="language" value="${
    escapeHtml(podcast.language)
  }" placeholder="en"></label>
        <label><span>Audio quality</span><select name="quality">
          <option value="high-m4a" ${
    podcast.quality === "high-m4a" ? "selected" : ""
  }>High · M4A 160 kbps</option>
          <option value="standard-mp3" ${
    podcast.quality === "standard-mp3" ? "selected" : ""
  }>Standard · MP3 128 kbps</option>
          <option value="compact-mp3" ${
    podcast.quality === "compact-mp3" ? "selected" : ""
  }>Compact · MP3 64 kbps</option>
        </select></label>
        <label><span>Description</span><textarea name="description">${
    escapeHtml(podcast.description)
  }</textarea></label>
        <label class="toggle-row"><input name="autoDownload" type="checkbox" ${
    podcast.autoDownload ? "checked" : ""
  }><span class="toggle"></span><span><strong>Auto-download new episodes</strong><small>Applied after each refresh</small></span></label>
        <button class="button secondary" type="submit">Save metadata</button>
      </form>
      <div class="danger-zone"><button class="text-button" data-action="remove">Remove podcast…</button></div>
    </aside>
  </div>`;
}

function openDetail(id) {
  state.currentPodcastId = id;
  state.selectedEpisodes.clear();
  state.episodeQuery = "";
  state.episodeFilter = "all";
  setView("detail");
  state.currentPodcastId = id;
  renderDetail();
}

function resetInspect() {
  state.inspection = null;
  $("#inspect-form").hidden = false;
  $("#inspect-loading").hidden = true;
  $("#add-form").hidden = true;
  $("#source-url").disabled = false;
  $("#source-url").focus();
}

function openAddDialog() {
  $("#source-url").value = "";
  $("#rights-confirm").checked = false;
  resetInspect();
  $("#add-dialog").showModal();
}

async function inspectLink(event) {
  event.preventDefault();
  const url = $("#source-url").value.trim();
  $("#inspect-form").hidden = true;
  $("#inspect-loading").hidden = false;
  try {
    const result = await api("/api/inspect", {
      method: "POST",
      body: JSON.stringify({
        url,
        rightsAcknowledged: $("#rights-confirm").checked,
      }),
    });
    state.inspection = result;
    $("#inspect-loading").hidden = true;
    $("#add-form").hidden = false;
    $("#preview-cover").innerHTML = `<div class="cover-fallback">${
      escapeHtml(result.title.slice(0, 1))
    }</div>`;
    $("#preview-provider").textContent = sourceName(result.sourceType);
    $("#preview-title").textContent = result.title;
    const excluded = Number(result.excludedEpisodeCount) || 0;
    $("#preview-meta").textContent = `${
      result.author || "Unknown publisher"
    } · ${result.episodes.length} downloadable episodes${
      excluded ? ` · ${excluded} inaccessible omitted` : ""
    }`;
    $("#preview-description").textContent = result.description ||
      "No source description available.";
    $("#add-title").value = result.title;
    $("#add-author").value = result.author;
    const downloadCount = $("#add-download-count");
    const mediaReady = state.status?.tools?.ffmpeg?.available === true;
    downloadCount.disabled = !mediaReady;
    downloadCount.title = mediaReady
      ? ""
      : "Install FFmpeg in Settings before downloading";
    if (!mediaReady) downloadCount.value = "0";
  } catch (error) {
    resetInspect();
    toast(error.message, "error");
  }
}

async function addPodcast(event) {
  event.preventDefault();
  if (!state.inspection) return;
  const countValue = $("#add-download-count").value;
  const count = countValue === "all"
    ? state.inspection.episodes.length
    : Number(countValue);
  const episodeIds = state.inspection.episodes.slice(0, count).map((episode) =>
    episode.id
  );
  const submit = event.submitter;
  submit.disabled = true;
  submit.textContent = "Adding…";
  try {
    const result = await api("/api/podcasts", {
      method: "POST",
      body: JSON.stringify({
        url: state.inspection.sourceUrl,
        rightsAcknowledged: true,
        title: $("#add-title").value.trim(),
        author: $("#add-author").value.trim(),
        quality: $("#add-quality").value,
        autoDownload: $("#add-auto").checked,
        episodeIds,
      }),
    });
    $("#add-dialog").close();
    await loadAll();
    openDetail(result.podcast.id);
    toast(
      episodeIds.length
        ? `Podcast added and ${episodeIds.length} episode${
          episodeIds.length === 1 ? "" : "s"
        } queued.`
        : "Podcast added to your library.",
    );
  } catch (error) {
    toast(error.message, "error");
  } finally {
    submit.disabled = false;
    submit.textContent = "Add to library";
  }
}

async function saveMetadata(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await api(`/api/podcasts/${encodeURIComponent(state.currentPodcastId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: data.get("title"),
        author: data.get("author"),
        description: data.get("description"),
        language: data.get("language"),
        quality: data.get("quality"),
        autoDownload: data.get("autoDownload") === "on",
        genres: String(data.get("genres") || "").split(",").map((item) =>
          item.trim()
        ).filter(Boolean),
      }),
    });
    await loadAll();
    renderDetail();
    toast("Metadata saved. Use Rewrite tags to apply it to downloaded files.");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function queueAction(action) {
  const podcastId = state.currentPodcastId;
  if (!podcastId) return;
  try {
    if (action === "download-selected") {
      if (!state.selectedEpisodes.size) return;
      await api(`/api/podcasts/${encodeURIComponent(podcastId)}/download`, {
        method: "POST",
        body: JSON.stringify({ episodeIds: [...state.selectedEpisodes] }),
      });
      state.selectedEpisodes.clear();
      toast("Episodes added to the download queue.");
    } else {
      await api(`/api/podcasts/${encodeURIComponent(podcastId)}/${action}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast(
        action === "refresh"
          ? "Source refresh queued."
          : "Metadata rewrite queued.",
      );
    }
    await loadAll();
    renderDetail();
  } catch (error) {
    toast(error.message, "error");
  }
}

function askRemove() {
  const podcast = state.podcasts.find((item) =>
    item.id === state.currentPodcastId
  );
  if (!podcast) return;
  state.removingId = podcast.id;
  $("#confirm-copy").textContent =
    `“${podcast.title}” will be removed from Castracker. Its audio stays on disk unless you select the option below.`;
  $("#remove-files").checked = false;
  $("#confirm-dialog").showModal();
}

async function confirmRemove() {
  if (!state.removingId) return;
  const removeFiles = $("#remove-files").checked;
  try {
    await api(
      `/api/podcasts/${
        encodeURIComponent(state.removingId)
      }?removeFiles=${removeFiles}`,
      { method: "DELETE" },
    );
    $("#confirm-dialog").close();
    state.removingId = null;
    await loadAll();
    setView("library");
    renderLibrary();
    toast(
      removeFiles
        ? "Podcast and its managed folder were removed."
        : "Podcast removed; audio files were kept.",
    );
  } catch (error) {
    toast(error.message, "error");
  }
}

async function loadAll() {
  const [status, podcasts, jobs] = await Promise.all([
    api("/api/status"),
    api("/api/podcasts"),
    api("/api/jobs"),
  ]);
  state.status = status;
  state.podcasts = podcasts;
  state.jobs = jobs;
  renderLibrary();
  renderJobs();
  renderSettings();
}

async function poll() {
  if (state.polling || document.hidden) return;
  state.polling = true;
  try {
    const activeBefore = state.jobs.some((job) =>
      ["queued", "running"].includes(job.status)
    );
    const [jobs, status] = await Promise.all([
      api("/api/jobs"),
      api("/api/status"),
    ]);
    state.jobs = jobs;
    state.status = status;
    const activeNow = jobs.some((job) =>
      ["queued", "running"].includes(job.status)
    );
    const podcastsChanged = activeBefore || activeNow;
    if (podcastsChanged) state.podcasts = await api("/api/podcasts");
    renderJobs();
    renderStats();
    renderSettings();
    if (state.view === "library" && podcastsChanged) renderLibrary();
    const audioPlaying = $$("audio", $("#podcast-detail")).some((audio) =>
      !audio.paused
    );
    if (
      state.view === "detail" && podcastsChanged && !audioPlaying &&
      !$("#podcast-detail").contains(document.activeElement)
    ) renderDetail();
  } catch {
    /* The next poll will retry after a transient server interruption. */
  } finally {
    state.polling = false;
  }
}

function wireEvents() {
  $("#jobs-list").addEventListener("click", (event) => {
    const button = event.target.closest(".job-show-failures");
    if (!button) return;
    state.episodeFilter = "issues";
    state.episodeQuery = "";
    state.selectedEpisodes.clear();
    setView("detail");
    state.currentPodcastId = button.dataset.podcastId;
    renderDetail();
  });
  $$(".nav-item").forEach((item) =>
    item.addEventListener("click", () => {
      setView(item.dataset.view);
      if (state.view === "library") renderLibrary();
    })
  );
  $("#open-add").addEventListener("click", openAddDialog);
  $("#empty-add").addEventListener("click", openAddDialog);
  $("#inspect-form").addEventListener("submit", inspectLink);
  $("#inspect-reset").addEventListener("click", resetInspect);
  $("#add-form").addEventListener("submit", addPodcast);
  $("#global-search").addEventListener("input", renderLibrary);
  $("#detail-back").addEventListener("click", () => {
    setView("library");
    renderLibrary();
  });
  $("#podcast-grid").addEventListener("click", (event) => {
    const card = event.target.closest("[data-podcast-id]");
    if (card) openDetail(card.dataset.podcastId);
  });
  $("#podcast-grid").addEventListener("keydown", (event) => {
    const card = event.target.closest("[data-podcast-id]");
    if (card && (event.key === "Enter" || event.key === " ")) {
      openDetail(card.dataset.podcastId);
    }
  });
  $("#library-path-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ libraryPath: $("#library-path").value }),
      });
      await loadAll();
      toast(
        "Library folder saved. Existing managed shows were moved when needed.",
      );
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#settings-view").addEventListener("click", async (event) => {
    if (event.target.id !== "install-ffmpeg") return;
    event.target.disabled = true;
    try {
      await api("/api/tools/ffmpeg/install", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadAll();
      setView("queue");
      toast("FFmpeg installation started. This is a one-time download.");
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#podcast-detail").addEventListener("input", (event) => {
    if (event.target.id === "episode-search") {
      state.episodeQuery = event.target.value;
      renderDetail();
      const input = $("#episode-search");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  $("#podcast-detail").addEventListener("change", (event) => {
    if (event.target.id === "episode-filter") {
      state.episodeFilter = event.target.value;
      renderDetail();
    }
    if (event.target.classList.contains("episode-check")) {
      event.target.checked
        ? state.selectedEpisodes.add(event.target.dataset.episodeId)
        : state.selectedEpisodes.delete(event.target.dataset.episodeId);
      const button = $(
        "[data-action='download-selected']",
        $("#podcast-detail"),
      );
      button.disabled = state.selectedEpisodes.size === 0 ||
        state.status?.tools?.ffmpeg?.available !== true;
      button.textContent = `Download selected (${state.selectedEpisodes.size})`;
      const podcast = state.podcasts.find((item) =>
        item.id === state.currentPodcastId
      );
      updateSelectionControls(podcast);
    }
  });
  $("#podcast-detail").addEventListener("submit", (event) => {
    if (event.target.id === "metadata-form") saveMetadata(event);
  });
  $("#podcast-detail").addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (["download-selected", "refresh", "retag"].includes(action)) {
      queueAction(action);
    }
    if (action === "remove") askRemove();
    if (action === "select-all" || action === "select-visible") {
      const podcast = state.podcasts.find((item) =>
        item.id === state.currentPodcastId
      );
      const selectable =
        (action === "select-all" ? podcast.episodes : filteredEpisodes(podcast))
          .filter(isSelectableEpisode);
      const allSelected = selectable.every((episode) =>
        state.selectedEpisodes.has(episode.id)
      );
      selectable.forEach((episode) =>
        allSelected
          ? state.selectedEpisodes.delete(episode.id)
          : state.selectedEpisodes.add(episode.id)
      );
      renderDetail();
    }
  });
  $("#cancel-remove").addEventListener(
    "click",
    () => $("#confirm-dialog").close(),
  );
  $("#confirm-remove").addEventListener("click", confirmRemove);
}

wireEvents();
try {
  await loadAll();
} catch (error) {
  toast(`The local service did not answer: ${error.message}`, "error");
}
setInterval(poll, 2000);
