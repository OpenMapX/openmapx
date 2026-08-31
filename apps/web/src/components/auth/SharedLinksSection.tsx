"use client";

import AutorenewIcon from "@mui/icons-material/Autorenew";
import DeleteIcon from "@mui/icons-material/Delete";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useRevokeShare, useRotateShare, useShares } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { forwardRef, useState } from "react";
import { ShareLinkCreated } from "@/components/share/ShareLinkCreated";

export const SharedLinksSection = forwardRef<HTMLHeadingElement>(
  function SharedLinksSection(_props, headingRef) {
    const t = useTranslations("share");
    const { data: shares } = useShares();
    const rotateShare = useRotateShare();
    const revokeShare = useRevokeShare();
    const [rotated, setRotated] = useState<{ id: string; token: string } | null>(null);

    return (
      <Box>
        <Typography
          ref={headingRef}
          tabIndex={-1}
          variant="subtitle2"
          sx={{ fontWeight: 600, mb: 1.5, outline: "none" }}
        >
          {t("sharedLinks")}
        </Typography>
        {!shares || shares.length === 0 ? (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("noSharedLinks")}
          </Typography>
        ) : (
          shares.map((share) => {
            const expired =
              share.expiresAt !== null && new Date(share.expiresAt).getTime() <= Date.now();
            return (
              <Box key={share.id} sx={{ py: 1, borderBottom: 1, borderColor: "divider" }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Chip
                    size="small"
                    label={share.targetType === "list" ? t("typeList") : t("typeRoute")}
                  />
                  <Typography sx={{ flex: 1, minWidth: 0 }} noWrap>
                    {share.label}
                  </Typography>
                  <IconButton
                    size="small"
                    aria-label={t("rotateLink")}
                    onClick={() =>
                      rotateShare.mutate(share.id, {
                        onSuccess: (result) => setRotated({ id: share.id, token: result.token }),
                      })
                    }
                  >
                    <AutorenewIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    aria-label={t("revokeLink")}
                    onClick={() => revokeShare.mutate(share.id)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {share.mode === "live" ? t("modeLive") : t("modeSnapshot")}
                  {" · "}
                  {new Date(share.createdAt).toLocaleDateString()}
                  {expired && ` · ${t("expiredBadge")}`}
                </Typography>
                {rotated?.id === share.id && <ShareLinkCreated token={rotated.token} />}
              </Box>
            );
          })
        )}
      </Box>
    );
  },
);
