"use strict";
/* Harangszó church photo, shared by the parish portal and the admin: the church's photo as the map shows it (with its
   credit in the corner), "Fotó feltöltése" and, where allowed, "Fotó törlése". Saved at once, not with the save bar.
   Upload: the picked image is made smaller in the browser (at most 1600 px on the long edge, JPEG ~0.85, white
   behind transparent parts), stored in the public 'church-photos' bucket as <church id>/<timestamp>.jpg, then put on
   the church with set_church_photo(cid, url) (migration 013); the database accepts only that church's folder.
   Remove: set_church_photo(cid, null). A parish cannot remove a Wikimedia Commons photo, only replace it; the admin
   can. The previous file of the parish's own photo is deleted from the bucket once it is no longer used.
   ChurchPhoto.mount(el, { sb, church, admin, toast, onChange }) — church is updated in place (photo_* fields). */
(function (w) {
  const BUCKET = "church-photos", MAX_EDGE = 1600, QUALITY = 0.85, MAX_BYTES = 5 * 1024 * 1024;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // The picked file as a JPEG blob, at most MAX_EDGE px on its long edge.
  async function toJpeg(file) {
    if (!file || (file.type && !file.type.startsWith("image/"))) throw new Error("not an image");
    let img = null, width = 0, height = 0, done = () => { };
    if (w.createImageBitmap) {
      try { img = await createImageBitmap(file, { imageOrientation: "from-image" }); width = img.width; height = img.height; done = () => img.close?.(); }
      catch (_) { img = null; }
    }
    if (!img) {
      const url = URL.createObjectURL(file);
      try {
        img = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error("not an image")); im.src = url; });
      } catch (e) { URL.revokeObjectURL(url); throw e; }
      width = img.naturalWidth; height = img.naturalHeight; done = () => URL.revokeObjectURL(url);
    }
    if (!width || !height) { done(); throw new Error("not an image"); }
    const k = Math.min(1, MAX_EDGE / Math.max(width, height));
    const cw = Math.max(1, Math.round(width * k)), ch = Math.max(1, Math.round(height * k));
    const canvas = document.createElement("canvas");
    canvas.width = cw; canvas.height = ch;
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, cw, ch);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, cw, ch);
    done();
    let q = QUALITY, blob = null;
    do { blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", q)); q -= 0.15; } while (blob && blob.size > MAX_BYTES && q > 0.4);
    if (!blob) throw new Error("could not encode");
    return { blob, width: cw, height: ch };
  }

  // The bucket path of a photo URL when it is this church's own upload ("1043/1762675200000.jpg"), otherwise null.
  function ownPath(cid, url) {
    const m = /\/storage\/v1\/object\/public\/church-photos\/([^?#]+)/.exec(url || "");
    const path = m ? decodeURIComponent(m[1]) : "";
    return path.startsWith(cid + "/") && !path.slice(String(cid).length + 1).includes("/") ? path : null;
  }

  function mount(el, { sb, church: c, admin = false, toast = () => { }, onChange = () => { } }) {
    let busy = false;
    el.classList.add("cp");
    el.innerHTML = `<div class="cp-view"></div><div class="cp-acts"></div><p class="cp-msg" role="status" aria-live="polite"></p>
      <p class="cp-hint">Fekvő, nappal készült fotó mutat a legjobban, amelyen az egész templom látszik. Csak saját fotót tölts fel, vagy olyat, amelyhez engedélyed van.</p>
      <input type="file" accept="image/*" data-cp="file" hidden>`;
    const view = el.querySelector(".cp-view"), acts = el.querySelector(".cp-acts"), msg = el.querySelector(".cp-msg"), input = el.querySelector("[data-cp=file]");
    const say = (t, err = false) => { msg.textContent = t; msg.classList.toggle("err", err); };

    function render() {
      const url = c.photo_url || "", commons = c.photo_source === "commons";
      if (!c.id) {
        view.innerHTML = `<p class="cp-none">Fotót a templom első mentése után tölthetsz fel.</p>`; acts.innerHTML = ""; return;
      }
      const credit = c.photo_credit || "";
      view.innerHTML = url ? `<figure class="cp-fig"><img src="${esc(url)}" alt="${esc("A templom fotója" + (c.name ? ": " + c.name : ""))}" decoding="async">
          ${credit ? `<figcaption class="cp-credit">${c.photo_page ? `<a href="${esc(c.photo_page)}" target="_blank" rel="noopener">${esc(credit)}</a>` : esc(credit)}</figcaption>` : ""}</figure>
          ${commons ? `<p class="cp-note">Ez a fotó a Wikimedia Commonsról való, szabadon felhasználható képek közül.${admin ? "" : " Ha van jobb, saját fotóval lecserélheted."}</p>` : ""}`
        : `<p class="cp-none">Még nincs fotó a templomról.</p>`;
      const canRemove = url && (admin || !commons);
      acts.innerHTML = `<button type="button" class="ui-btn secondary" data-cp="pick"${busy ? " disabled" : ""}>${busy === "up" ? "Feltöltés…" : "Fotó feltöltése"}</button>
        ${canRemove ? `<button type="button" class="ui-btn danger" data-cp="del"${busy ? " disabled" : ""}>${busy === "del" ? "Törlés…" : "Fotó törlése"}</button>` : ""}`;
    }
    // Read back what the database stored (set_church_photo sets the credit); the local guess if that fails.
    async function reload(guess) {
      const { data } = await sb.from("churches").select("photo_url,photo_credit,photo_source,photo_page").eq("id", c.id).single();
      Object.assign(c, data && "photo_url" in data ? data : guess);
      onChange(c);
    }
    const forget = path => { if (path) sb.storage.from(BUCKET).remove([path]).catch(() => { }); };

    async function upload(file) {
      if (busy || !file) return;
      const old = ownPath(c.id, c.photo_url);
      busy = "up"; render(); say("Egy pillanat, a fotót feltöltjük…");
      try {
        let jpeg;
        try { jpeg = await toJpeg(file); }
        catch (_) { throw new Error("Ezt a fájlt nem tudtuk fotóként megnyitni. Válassz egy JPEG vagy PNG képet."); }
        const path = `${c.id}/${Date.now()}.jpg`;
        const up = await sb.storage.from(BUCKET).upload(path, jpeg.blob, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
        if (up.error) throw new Error("Nem sikerült feltölteni: " + up.error.message);
        const url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
        const { error } = await sb.rpc("set_church_photo", { cid: c.id, url });
        if (error) { forget(path); throw new Error("Nem sikerült a fotót a templomhoz tenni: " + error.message); }
        await reload({ photo_url: url, photo_credit: "Fotó: a plébánia", photo_source: "parish", photo_page: null });
        if (old && old !== path) forget(old);
        say("");
        toast(c.published ? "A fotó felkerült · már látszik a térképen" : "A fotó felkerült");
      } catch (e) { say(e.message || String(e), true); }
      finally { busy = false; render(); }
    }
    async function remove() {
      if (busy || !c.photo_url) return;
      if (!w.confirm("Biztosan törlöd a fotót? A térképen ezután fotó nélkül látszik a templom.")) return;
      const old = ownPath(c.id, c.photo_url);
      busy = "del"; render(); say("");
      try {
        const { error } = await sb.rpc("set_church_photo", { cid: c.id, url: null });
        if (error) throw new Error("Nem sikerült törölni: " + error.message);
        await reload({ photo_url: null, photo_credit: null, photo_source: null, photo_page: null });
        forget(old);
        toast("A fotót töröltük");
      } catch (e) { say(e.message || String(e), true); }
      finally { busy = false; render(); }
    }

    el.addEventListener("click", e => {
      const b = e.target.closest("[data-cp]"); if (!b || b.disabled) return;
      if (b.dataset.cp === "pick") { input.value = ""; input.click(); }
      else if (b.dataset.cp === "del") remove();
    });
    input.addEventListener("change", () => upload(input.files && input.files[0]));
    render();
    return { render };
  }

  w.ChurchPhoto = { mount, toJpeg, ownPath, BUCKET, MAX_EDGE };
})(window);
