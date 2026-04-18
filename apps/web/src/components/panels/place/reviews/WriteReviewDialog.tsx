"use client";

import CloseIcon from "@mui/icons-material/Close";
import PhotoCameraOutlinedIcon from "@mui/icons-material/PhotoCameraOutlined";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Rating from "@mui/material/Rating";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  EXPERIENCE_CONTEXT_GEO,
  fingerprintPem,
  type GeoExperienceContext,
  type Review,
  useSession,
  useSubmitReview,
  useUploadReviewImage,
  useUserKeypair,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

type Experience = GeoExperienceContext;

interface Props {
  open: boolean;
  onClose: () => void;
  subject: { lat: number; lng: number; name: string; osmId?: string };
  /** Pre-filled values when editing an existing review. */
  initial?: Review | null;
}

const EXPERIENCES: readonly Experience[] = EXPERIENCE_CONTEXT_GEO;

const EXPERIENCE_I18N_KEY: Record<Experience, string> = {
  business: "experienceBusiness",
  family: "experienceFamily",
  "couple/date": "experienceCoupleDate",
  sightseeing: "experienceSightseeing",
  friends: "experienceFriends",
};
const LICENSES = ["CC-BY-4.0", "CC-BY-SA-4.0"] as const;
const LICENSE_URLS: Record<(typeof LICENSES)[number], string> = {
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
};
const MANGROVE_HOME_URL = "https://mangrove.reviews/";
const MANGROVE_TERMS_URL = "https://mangrove.reviews/terms";
const MANGROVE_PRIVACY_URL = "https://mangrove.reviews/terms#2-privacy-policy";
const MAX_OPINION = 1000;
const MAX_PHOTOS = 5;

const linkSx = {
  color: "primary.main",
  textDecoration: "underline",
  "&:hover": { textDecoration: "underline" },
};

/** Inline red asterisk for required-field labels. */
function RequiredMark() {
  return (
    <Box component="span" sx={{ color: "error.main", ml: 0.5 }} aria-hidden="true">
      *
    </Box>
  );
}

export function WriteReviewDialog({ open, onClose, subject, initial }: Props) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const { keypair, publicPem, isLoading: keypairLoading } = useUserKeypair();
  const { data: session } = useSession();
  const sessionName = session?.user?.name?.trim();
  const fingerprint = publicPem ? fingerprintPem(publicPem) : null;
  const publishingAsName = sessionName || (fingerprint ? `User ${fingerprint}` : null);
  const submit = useSubmitReview();
  const upload = useUploadReviewImage();

  const [stars, setStars] = useState<number | null>(initial?.stars ?? null);
  const [opinion, setOpinion] = useState(initial?.opinion ?? "");
  const [images, setImages] = useState<{ src: string; label?: string }[]>(initial?.images ?? []);
  const [experience, setExperience] = useState<Experience | null>(
    (initial?.metadata?.experienceContext as Experience | undefined) ?? null,
  );
  const [isAffiliated, setIsAffiliated] = useState(!!initial?.metadata?.isAffiliated);
  const [license, setLicense] = useState<"CC-BY-4.0" | "CC-BY-SA-4.0">(
    initial?.metadata?.license ?? "CC-BY-4.0",
  );
  // Consents must be re-confirmed per submission — every signed JWT is a
  // fresh publishing action that gets broadcast to Mangrove under the chosen
  // license. We never carry consent forward, even when editing.
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Track the (open, initial.id) pair we last reset for, so we only re-seed
  // form state on open/close or when editing a different review — not on
  // every rerender. Keeps the effect's dep list minimal and avoids linter
  // churn over deeply-nested `initial.*` props.
  const lastResetRef = useRef<string | null>(null);
  const resetKey = open ? (initial?.id ?? "new") : "closed";
  if (lastResetRef.current !== resetKey) {
    lastResetRef.current = resetKey;
    if (!open) {
      setUploadError(null);
      setStars(null);
      setOpinion("");
      setImages([]);
      setExperience(null);
      setIsAffiliated(false);
      setLicense("CC-BY-4.0");
      setAcceptedTerms(false);
      setAcceptedPrivacy(false);
    } else {
      setStars(initial?.stars ?? null);
      setOpinion(initial?.opinion ?? "");
      setImages(initial?.images ?? []);
      setExperience((initial?.metadata?.experienceContext as Experience | undefined) ?? null);
      setIsAffiliated(!!initial?.metadata?.isAffiliated);
      setLicense(initial?.metadata?.license ?? "CC-BY-4.0");
      setAcceptedTerms(false);
      setAcceptedPrivacy(false);
    }
  }

  // `submit.reset` / `upload.reset` are recreated every render by TanStack
  // Query, so listing them as deps would fire this effect on every render.
  // We only want to clear mutation state when the dialog closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!open) {
      submit.reset();
      upload.reset();
    }
  }, [open]);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    setUploadError(null);
    const remaining = MAX_PHOTOS - images.length;
    const picked = Array.from(files).slice(0, remaining);
    for (const file of picked) {
      try {
        const { src } = await upload.mutateAsync(file);
        setImages((prev) => [...prev, { src, label: file.name.slice(0, 50) }]);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
        break;
      }
    }
  }

  function removeImage(src: string) {
    setImages((prev) => prev.filter((i) => i.src !== src));
  }

  async function handleSubmit() {
    if (!keypair) return;
    await submit.mutateAsync({
      subject,
      stars: stars ?? undefined,
      opinion: opinion.trim() || undefined,
      images: images.length ? images : undefined,
      experience: experience ?? undefined,
      isAffiliated: isAffiliated || undefined,
      license,
      action: initial ? "edit" : undefined,
      editTargetId: initial?.id,
    });
    onClose();
  }

  const charsLeft = MAX_OPINION - opinion.length;
  const hasContent = stars !== null || opinion.trim().length > 0;
  const canSubmit = !!keypair && hasContent && acceptedTerms && acceptedPrivacy;
  const isBusy = submit.isPending || upload.isPending || keypairLoading;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="write-review-title"
    >
      <DialogTitle
        id="write-review-title"
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1 }}
      >
        <Box component="span">
          {t.rich(initial ? "editReviewOn" : "writeReviewOn", {
            m: (chunks) => (
              <Box
                component="a"
                href={MANGROVE_HOME_URL}
                target="_blank"
                rel="noopener noreferrer"
                sx={linkSx}
              >
                {chunks}
              </Box>
            ),
          })}
        </Box>
        <IconButton onClick={onClose} aria-label="Close" size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="subtitle2" gutterBottom>
          {subject.name}
        </Typography>

        {publishingAsName && fingerprint && (
          <Typography
            variant="caption"
            color="text.secondary"
            display="block"
            sx={{ mb: 2, lineHeight: 1.5 }}
          >
            {t.rich("publishingAs", {
              name: publishingAsName,
              key: fingerprint,
              b: (chunks) => <Box component="strong">{chunks}</Box>,
              k: (chunks) => (
                <Box
                  component="code"
                  sx={{
                    fontFamily: "monospace",
                    fontSize: "0.85em",
                    bgcolor: "action.hover",
                    px: 0.5,
                    borderRadius: 0.5,
                  }}
                >
                  {chunks}
                </Box>
              ),
            })}
          </Typography>
        )}

        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" gutterBottom>
            {t("yourRating")}
          </Typography>
          <Rating
            value={stars}
            precision={1}
            size="large"
            onChange={(_, v) => setStars(v)}
            sx={{ "& .MuiRating-iconFilled": { color: "#FBBC04" } }}
          />
        </Box>

        <TextField
          label={t("reviewPlaceholder")}
          value={opinion}
          onChange={(e) => setOpinion(e.target.value.slice(0, MAX_OPINION))}
          multiline
          rows={5}
          fullWidth
          helperText={t("reviewCharsLeft", { n: charsLeft })}
          FormHelperTextProps={{ sx: { textAlign: "right" } }}
          sx={{ mb: 2 }}
        />

        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t("addPhotos")}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
            {images.map((img) => (
              <Box
                key={img.src}
                sx={{
                  position: "relative",
                  width: 72,
                  height: 72,
                  borderRadius: 1,
                  backgroundImage: `url("${img.src}")`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                <IconButton
                  size="small"
                  onClick={() => removeImage(img.src)}
                  sx={{
                    position: "absolute",
                    top: -6,
                    right: -6,
                    bgcolor: "background.paper",
                    boxShadow: 1,
                    p: 0.25,
                    "&:hover": { bgcolor: "grey.200" },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Box>
            ))}
            {images.length < MAX_PHOTOS && (
              <Button
                component="label"
                variant="outlined"
                color="inherit"
                disabled={upload.isPending}
                sx={{
                  width: 72,
                  height: 72,
                  minWidth: 72,
                  p: 0,
                  borderStyle: "dashed",
                }}
              >
                {upload.isPending ? <CircularProgress size={20} /> : <PhotoCameraOutlinedIcon />}
                <input
                  hidden
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => handleFiles(e.target.files)}
                />
              </Button>
            )}
          </Stack>
          {uploadError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {uploadError}
            </Alert>
          )}
        </Box>

        <Box sx={{ mb: 2 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t("experience")}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
            {EXPERIENCES.map((e) => (
              <Chip
                key={e}
                label={t(EXPERIENCE_I18N_KEY[e])}
                onClick={() => setExperience(experience === e ? null : e)}
                variant={experience === e ? "filled" : "outlined"}
                color={experience === e ? "primary" : "default"}
                size="small"
              />
            ))}
          </Stack>
        </Box>

        <Box sx={{ mb: 1.5 }}>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
            {t("contentLicense")}
          </Typography>
          <Stack direction="row" spacing={1}>
            {LICENSES.map((l) => (
              <Chip
                key={l}
                label={l}
                size="small"
                onClick={() => setLicense(l)}
                variant={license === l ? "filled" : "outlined"}
                color={license === l ? "primary" : "default"}
              />
            ))}
          </Stack>
        </Box>

        <Stack spacing={0.5} sx={{ mt: 1 }}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={isAffiliated}
                onChange={(e) => setIsAffiliated(e.target.checked)}
              />
            }
            sx={{
              alignItems: "flex-start",
              m: 0,
              gap: 1,
              "& .MuiCheckbox-root": { p: 0, mt: "1px" },
            }}
            label={
              <Typography variant="body2" color="text.secondary">
                {t.rich("affiliationNotice", {
                  placeName: subject.name,
                  i: (chunks) => <em>{chunks}</em>,
                })}
              </Typography>
            }
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={acceptedTerms}
                onChange={(e) => setAcceptedTerms(e.target.checked)}
              />
            }
            sx={{
              alignItems: "flex-start",
              m: 0,
              gap: 1,
              "& .MuiCheckbox-root": { p: 0, mt: "1px" },
            }}
            label={
              <Typography variant="body2" color="text.secondary">
                {t.rich("termsAgreement", {
                  terms: (chunks) => (
                    <Box
                      component="a"
                      href={MANGROVE_TERMS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={linkSx}
                    >
                      {chunks}
                    </Box>
                  ),
                })}
                <RequiredMark />
              </Typography>
            }
          />
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={acceptedPrivacy}
                onChange={(e) => setAcceptedPrivacy(e.target.checked)}
              />
            }
            sx={{
              alignItems: "flex-start",
              m: 0,
              gap: 1,
              "& .MuiCheckbox-root": { p: 0, mt: "1px" },
            }}
            label={
              <Typography variant="body2" color="text.secondary">
                {t.rich("privacyLicenseAgreement", {
                  license: (chunks) => (
                    <Box
                      component="a"
                      href={LICENSE_URLS[license]}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={linkSx}
                    >
                      {chunks}
                    </Box>
                  ),
                  licenseId: license,
                  privacy: (chunks) => (
                    <Box
                      component="a"
                      href={MANGROVE_PRIVACY_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={linkSx}
                    >
                      {chunks}
                    </Box>
                  ),
                })}
                <RequiredMark />
              </Typography>
            }
          />
        </Stack>

        {submit.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {submit.error instanceof Error ? submit.error.message : "Submit failed"}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} color="inherit">
          {tc("cancel")}
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={!canSubmit || isBusy}
          startIcon={isBusy ? <CircularProgress size={16} /> : null}
        >
          {t("submitReview")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
