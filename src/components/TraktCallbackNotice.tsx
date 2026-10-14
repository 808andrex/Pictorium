"use client"

import { useEffect } from "react"
import { toast } from "sonner"
import { useT } from "@/lib/contexts/TranslationContext"
import { usePSelector } from "@/lib/context"
import { requestSettingsTab } from "@/lib/settings-tab"

type TraktResult = "connected" | "denied" | "failed"

function isTraktResult(v: string | null): v is TraktResult {
  return v === "connected" || v === "denied" || v === "failed"
}

/**
 * OAuth return handler: the Trakt callback redirects the browser to a fixed
 * profile-safe `?trakt=<connected|denied|failed>` URL — the initiating
 * profile's configure page (`/u/<uuid>/configure`, UUID from the consumed
 * server state only, never a `next`/`return` param) after a valid state, or
 * the generic home (`/`) when there was no valid state. This notice consumes
 * exactly that token (nothing else — arbitrary values are left untouched),
 * toasts the outcome through the existing notification pattern, removes ONLY
 * the `trakt` query param (history.replaceState: no navigation, other
 * params/hash/path — including `/u/<uuid>` — preserved), then opens the
 * Settings Space panel so the user lands on the connection state. It never
 * switches profile and never trusts redirect targets from the URL.
 */
export function TraktCallbackNotice() {
  const { t } = useT()
  const setSettingsOpen = usePSelector((v) => v.setSettingsOpen)

  useEffect(() => {
    let value: string | null
    try {
      value = new URLSearchParams(window.location.search).get("trakt")
    } catch {
      return
    }
    if (!isTraktResult(value)) return
    if (value === "connected") toast.success(t("ui.traktCallbackConnected"))
    else if (value === "denied") toast.error(t("ui.traktCallbackDenied"))
    else toast.error(t("ui.traktCallbackFailed"))
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete("trakt")
      const rest = url.searchParams.toString()
      window.history.replaceState(null, "", `${url.pathname}${rest ? `?${rest}` : ""}${url.hash}`)
    } catch {
      /* query cleanup is best-effort: the toast already fired */
    }
    try {
      requestSettingsTab("spazio")
      setSettingsOpen(true)
    } catch {
      /* panel open is best-effort: the toast already fired */
    }
    // Runs once per callback token: after cleanup the param is gone, so a
    // re-run (e.g. language switch re-rendering `t`) is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
