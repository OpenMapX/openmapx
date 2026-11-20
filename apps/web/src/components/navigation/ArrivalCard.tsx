"use client";

import LocalParkingIcon from "@mui/icons-material/LocalParking";
import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ArrivalParkingMarkers } from "./ArrivalParkingMarkers";
import { NearbyParkingCarousel } from "./NearbyParkingCarousel";
import { useArrivalHandoff } from "./useArrivalHandoff";
import { WalkingHandoffCard } from "./WalkingHandoffCard";

export interface ArrivalCardProps {
  onClose: () => void;
  destinationName?: string | null;
}

export function ArrivalCard({ onClose, destinationName }: ArrivalCardProps) {
  const t = useTranslations("navigation");
  const tParking = useTranslations("parking");
  const [toast, setToast] = useState<string | null>(null);

  const {
    destinationName: resolvedDestinationName,
    destinationCoords,
    canSaveParking,
    showParkingOptions,
    isSavingParking,
    isParkingSaved,
    handleSaveParking,
    walkingRoute,
    isWalkingLoading,
    handleStartWalking,
    nearbyParking,
    isParkingLoading,
    selectedParking,
    handleSelectParking,
    handleDriveToParking,
    isStartingHandoff,
    handleDone,
  } = useArrivalHandoff({ onClose, destinationName });

  const onSaveParkingPress = async () => {
    try {
      const outcome = await handleSaveParking();
      setToast(outcome === "saved" ? tParking("savedToast") : tParking("locationUnavailable"));
    } catch {
      setToast(tParking("locationUnavailable"));
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 2,
        p: { xs: 2, sm: 3 },
        width: "100%",
        maxWidth: { xs: "100%", sm: 440 },
        boxSizing: "border-box",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5, width: "100%" }}>
        <PlaceIcon color="primary" sx={{ fontSize: 28, mt: 0.25 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("arrived")}
          </Typography>
          {resolvedDestinationName && (
            <Typography component="h2" sx={{ fontSize: 22, fontWeight: 500, lineHeight: 1.3 }}>
              {resolvedDestinationName}
            </Typography>
          )}
        </Box>
      </Box>

      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", width: "100%" }}>
        <Button variant="contained" onClick={handleDone}>
          {t("done")}
        </Button>
        {canSaveParking && (
          <Button
            variant="tonal"
            startIcon={<LocalParkingIcon />}
            disabled={isSavingParking || isParkingSaved || isStartingHandoff}
            onClick={() => void onSaveParkingPress()}
          >
            {tParking("saveParking")}
          </Button>
        )}
      </Box>

      {canSaveParking && (
        <>
          <WalkingHandoffCard
            route={walkingRoute}
            isLoading={isWalkingLoading}
            onStartWalking={() => {
              void handleStartWalking().then((started) => {
                if (!started) setToast(t("handoffFailed"));
              });
            }}
            disabled={isStartingHandoff}
          />
          {showParkingOptions && (
            <>
              <NearbyParkingCarousel
                places={nearbyParking}
                selectedPlace={selectedParking}
                isLoading={isParkingLoading}
                onSelectPlace={handleSelectParking}
                onDriveToPlace={(place) => {
                  void handleDriveToParking(place).then((started) => {
                    if (!started) setToast(t("handoffFailed"));
                  });
                }}
                destinationCoords={destinationCoords}
                disabled={isStartingHandoff}
              />
              <ArrivalParkingMarkers
                places={nearbyParking}
                selectedPlace={selectedParking}
                onSelectPlace={handleSelectParking}
                disabled={isStartingHandoff}
              />
            </>
          )}
        </>
      )}

      <Snackbar
        open={toast !== null}
        message={toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
      />
    </Box>
  );
}
