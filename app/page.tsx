"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/Skeleton";
import { setGlobalLang, type Lang } from "@/lib/i18n";
import { preferredLang } from "@/lib/lang";
import { LAST_KEY, adoptLegacy, createProject, loadProject, memoryBackend, openElsewhere, openProjects, readOnly, receiveDesign, resolveProject, smallStorage, writesSettled, type Backend, type Project } from "@/lib/projects";
import { hasShareHash, readShareHash, shareable } from "@/lib/share";
import { isProject } from "@/lib/project";
import type { Doc } from "@/lib/tokens";
import type { EditorNotice } from "./Editor";

const loadEditor = () => import("./Editor");
/* the editor chunk starts downloading as soon as this module runs, alongside hydration,
   instead of waiting for the first client render */
if (typeof window !== "undefined") void loadEditor();

const Editor = dynamic(loadEditor, { ssr: false, loading: () => null });

/** the static page: the editor's shell with nothing in it, standing over the editor until
 *  the document has been read, then fading away to show the real one in its place */
function Boot({ done }: { done: boolean }) {
  return (
    <div className="m3e-boot" data-done={done ? "" : undefined} aria-busy={!done} aria-hidden={done}>
      <Skeleton />
    </div>
  );
}

/** how long the overlay takes to fade; matches .m3e-boot in globals.css */
const BOOT_FADE_MS = 420;

/** the address parameter naming the project a tab works on, so a reload stays on it */
const PROJECT_PARAM = "p";
const wantedId = () => new URLSearchParams(window.location.search).get(PROJECT_PARAM);
const addressOf = (id: string) => `${window.location.pathname}?${PROJECT_PARAM}=${encodeURIComponent(id)}`;

type Opened = { backend: Backend; project: Project; notice?: EditorNotice; sharedName?: string };

/** A design kept on the server beside the app, so one short address always opens its
 *  latest version: `#shared=<name>` fetches `shared/<name>.json` (no-store) and takes it
 *  as the visit's design, updating in place the project an earlier shared visit made. */
const SHARED_PARAM = "shared";
const sharedName = () => {
  const name = new URLSearchParams(window.location.hash.replace(/^#/, "")).get(SHARED_PARAM);
  return name && /^[a-z0-9-]+$/i.test(name) ? name : null;
};

async function fetchSharedDoc(name: string): Promise<Doc | null> {
  try {
    const base = window.location.pathname.replace(/[^/]*$/, "");
    const res = await fetch(`${base}shared/${name}.json`, { cache: "no-store" });
    if (!res.ok) return null;
    const value: unknown = await res.json();
    return isProject(value) ? value : null;
  } catch {
    return null;
  }
}

/** the shared name whose project this is, if any: a shared visit remembers the project
 *  it made in localStorage, so a later visit to that same project is still a shared one */
function sharedNameOf(id: string): string | undefined {
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("m3e:shared:") && window.localStorage.getItem(k) === id) return k.slice("m3e:shared:".length);
    }
  } catch {}
  return undefined;
}

/** Reads the project the address asks for. A design carried in the address's hash is taken
 *  here, before any editor is mounted: into the project when the author has not touched it
 *  and no other tab has it open, otherwise into a project of its own. */
async function openStored(): Promise<Opened> {
  /* an editor of this page that was just left may still be writing: read after it has finished */
  await writesSettled();
  const backend = await openProjects();
  /* a visit whose projects live in memory leaves no notes behind: nothing it opens or moves is kept */
  const storage = backend.kind === "memory" ? readOnly(smallStorage()) : smallStorage();
  const resolved = await resolveProject(backend, storage, wantedId());
  let project = resolved.project;
  let notice: EditorNotice | undefined = resolved.missing ? "missing" : undefined;
  const shared = sharedName();
  if (shared) {
    const doc = await fetchSharedDoc(shared);
    if (doc) {
      /* the project this shared name made on an earlier visit is updated in place, so the
       * address keeps naming one shared project instead of a new copy per visit */
      const key = `m3e:shared:${shared}`;
      let kept: Project | null = null;
      try {
        const prevId = storage.getItem(key);
        if (prevId) kept = await loadProject(backend, prevId);
      } catch {}
      if (kept) {
        const meta = { ...kept.meta, title: doc.title, updatedAt: Date.now(), screens: doc.frames.length, edited: true };
        await backend.write(meta, { doc, before: null });
        project = (await loadProject(backend, meta.id)) ?? project;
      } else {
        const meta = await createProject(backend, doc);
        project = (await loadProject(backend, meta.id)) ?? project;
        try {
          storage.setItem(key, meta.id);
        } catch {}
      }
      try {
        storage.setItem(LAST_KEY, project.meta.id);
      } catch {}
    } else {
      notice = "invalid";
    }
  } else if (hasShareHash(window.location.hash)) {
    const doc = await readShareHash(window.location.hash);
    if (doc) {
      const meta = await receiveDesign(backend, (await openElsewhere(project.meta.id)) ? null : project.meta, doc);
      /* the design is what this visit is about, whatever the address said of a project */
      notice = meta.id !== project.meta.id ? "arrived" : undefined;
      project = (await loadProject(backend, meta.id)) ?? project;
      try {
        storage.setItem(LAST_KEY, project.meta.id);
      } catch {}
    } else {
      notice = "invalid";
    }
  }
  const sharedFor = sharedNameOf(project.meta.id);
  /* the hash is dropped with the same stroke: the design has been taken or declined */
  window.history.replaceState(null, "", addressOf(project.meta.id));
  return { backend, project, notice, sharedName: sharedFor };
}

/** What a visit falls back to when storage would not open the project (a quota that is full,
 *  a database that fails): the same editor on a store that lives only as long as the tab, with
 *  the design the visit came for in it, and a notice. Showing the work unsaved is better than
 *  showing nothing. Stored projects are not touched, and the address keeps naming the project
 *  that was asked for, so a reload tries again. */
async function openUnstored(): Promise<Opened> {
  const backend = memoryBackend();
  let doc: Doc | null = null;
  try {
    if (hasShareHash(window.location.hash)) doc = await readShareHash(window.location.hash);
  } catch {}
  /* whether there is a store at all; if there is, it refused this once and holds its projects still */
  const real = await openProjects().then(
    (b) => b.kind !== "memory",
    () => false,
  );
  let meta = doc ? await createProject(backend, doc) : null;
  /* only a browser with no store at all is shown the document an earlier version kept: where
     there is a store, that entry is an old backup, and showing it would look like lost work */
  if (!meta && !real) meta = await adoptLegacy(backend, readOnly(smallStorage()), Date.now(), (work) => work()).catch(() => null);
  meta ??= await createProject(backend, null);
  const project = (await loadProject(backend, meta.id)) ?? { meta, doc: null, before: null };
  try {
    /* the design has been taken into the editor: only its hash goes, so the editor does not take it twice */
    if (doc) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  } catch {}
  return { backend, project, notice: real ? "unkept" : "unsaved" };
}

async function openForAddress(): Promise<Opened> {
  try {
    return await openStored();
  } catch {
    return openUnstored();
  }
}

export default function Page() {
  const [lang, setLang] = useState<Lang | null>(null);
  const [phase, setPhase] = useState<"loading" | "fading" | "done">("loading");
  const [opened, setOpened] = useState<Opened | null>(null);
  const openedRef = useRef<Opened | null>(null);
  openedRef.current = opened;
  const opening = useRef<Promise<Opened> | null>(null);

  useEffect(() => {
    const initialLang = preferredLang();
    document.documentElement.lang = initialLang;
    setGlobalLang(initialLang);
    setLang(initialLang);
  }, []);

  /** another project takes the page: the shell covers the change, then fades again */
  const show = useCallback((next: Opened) => {
    setPhase("loading");
    setOpened(next);
  }, []);

  useEffect(() => {
    let active = true;
    /* one read per page load, even when development runs this effect twice */
    opening.current ??= openForAddress();
    void opening.current.then((next) => active && setOpened(next));
    /* back and forward between projects opened in this tab */
    const onPop = () => {
      const id = wantedId();
      const current = openedRef.current;
      if (!id || !current || id === current.project.meta.id) return;
      void writesSettled()
        .then(() => loadProject(current.backend, id))
        .then(
          (project) => {
            if (!active) return;
            /* the project that entry named is gone: the address goes back to the one on screen */
            if (!project) {
              window.history.replaceState(null, "", addressOf(current.project.meta.id));
              return;
            }
            try {
              smallStorage().setItem(LAST_KEY, id);
            } catch {}
            show({ backend: current.backend, project });
          },
          () => {
            /* it could not be read: the address stays with the project on screen */
            if (active) window.history.replaceState(null, "", addressOf(current.project.meta.id));
          },
        );
    };
    window.addEventListener("popstate", onPop);
    return () => {
      active = false;
      window.removeEventListener("popstate", onPop);
    };
  }, [show]);

  useEffect(() => {
    if (phase !== "fading") return;
    const id = setTimeout(() => setPhase("done"), BOOT_FADE_MS);
    return () => clearTimeout(id);
  }, [phase]);

  const [pub, setPub] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [asking, setAsking] = useState(false);
  const [tokenText, setTokenText] = useState("");

  /** publish the shared project on screen back to the server's shared file, so every
   *  browser opening the shared address sees this version */
  const publish = useCallback(async () => {
    const current = openedRef.current;
    if (!current?.sharedName || pub === "busy") return;
    setPub("busy");
    try {
      await writesSettled();
      const fresh = await loadProject(current.backend, current.project.meta.id);
      const doc = fresh?.doc ?? current.project.doc;
      if (!doc) throw new Error("nothing to publish");
      const base = window.location.pathname.replace(/[^/]*$/, "");
      const cfg: unknown = await (await fetch(`${base}shared/config.json`, { cache: "no-store" })).json();
      const writeUrl = (cfg as { writeUrl?: string }).writeUrl;
      if (!writeUrl) throw new Error("no write endpoint configured");
      const TOKEN_KEY = "m3e:shared:token";
      const token = window.localStorage.getItem(TOKEN_KEY);
      if (!token) {
        /* no password yet: ask in the page itself (a native prompt is dismissed
         * unseen by some browsers, which would abort the publish silently) */
        setPub("idle");
        setAsking(true);
        return;
      }
      const res = await fetch(`${writeUrl}/shared/${current.sharedName}.json`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shared-token": token },
        body: JSON.stringify(shareable(doc)),
      });
      if (res.status === 401) window.localStorage.removeItem(TOKEN_KEY);
      if (!res.ok) throw new Error(`publish failed: ${res.status}`);
      setPub("done");
      setTimeout(() => setPub("idle"), 2500);
    } catch {
      setPub("error");
      setTimeout(() => setPub("idle"), 3000);
    }
  }, [pub]);

  /** keep the shared password the author typed, then publish with it */
  const confirmToken = useCallback(() => {
    const value = tokenText.trim();
    if (!value) return;
    try {
      window.localStorage.setItem("m3e:shared:token", value);
    } catch {}
    setTokenText("");
    setAsking(false);
    void publish();
  }, [tokenText, publish]);

  /** a design that reached an editor whose project already holds work */
  const arrive = useCallback(
    async (doc: Doc): Promise<boolean> => {
      const current = openedRef.current;
      if (!current) return false;
      try {
        const meta = await createProject(current.backend, doc);
        const project = await loadProject(current.backend, meta.id);
        if (!project) return false;
        try {
          smallStorage().setItem(LAST_KEY, meta.id);
        } catch {}
        window.history.pushState(null, "", addressOf(meta.id));
        show({ backend: current.backend, project, notice: "arrived" });
        return true;
      } catch {
        /* it did not fit: the editor that offered it says so, and stays as it is */
        return false;
      }
    },
    [show],
  );

  return (
    <>
      {lang && opened && (
        <Editor
          key={opened.project.meta.id}
          initialLang={lang}
          project={opened.project}
          backend={opened.backend}
          notice={opened.notice}
          onArrive={arrive}
          onReady={() => setPhase((p) => (p === "loading" ? "fading" : p))}
        />
      )}
      {phase !== "done" && <Boot done={phase === "fading"} />}
      {opened?.sharedName &&
        (asking ? (
          <div style={{ position: "fixed", top: 12, right: 12, zIndex: 10000, display: "flex", gap: 8, alignItems: "center", background: "#fff", padding: 8, borderRadius: 999, boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }}>
            <input
              type="password"
              value={tokenText}
              onChange={(e) => setTokenText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirmToken()}
              placeholder="共享口令（只需输一次）"
              autoFocus
              style={{ border: "1px solid #ccc", borderRadius: 999, padding: "6px 12px", fontSize: 14, outline: "none", color: "#111", background: "#fff" }}
            />
            <button type="button" onClick={confirmToken} style={{ padding: "6px 14px", borderRadius: 999, border: "none", background: "#0b57d0", color: "#fff", fontSize: 14, cursor: "pointer" }}>
              同步
            </button>
            <button type="button" onClick={() => setAsking(false)} style={{ padding: "6px 10px", borderRadius: 999, border: "none", background: "transparent", color: "#555", fontSize: 14, cursor: "pointer" }}>
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void publish()}
            style={{ position: "fixed", top: 12, right: 12, zIndex: 9999, padding: "8px 16px", borderRadius: 999, border: "none", background: "#0b57d0", color: "#fff", fontSize: 14, cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }}
          >
            {pub === "busy" ? "发布中…" : pub === "done" ? "已同步 ✓" : pub === "error" ? "同步失败，点重试" : "发布到共享"}
          </button>
        ))}
    </>
  );
}
