import BottomSheet, {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet";
import * as Haptics from "expo-haptics";
import { ImpactFeedbackStyle } from "expo-haptics";
import type { ReactNode } from "react";
import { useCallback, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "react-native-paper";

interface BottomSheetWrapperProps {
  snapPoints: (string | number)[];
  initialSnap?: number;
  onDismiss: () => void;
  children: ReactNode;
}

function Handle() {
  return (
    <View style={styles.handleContainer}>
      <View style={styles.handle} />
    </View>
  );
}

export function BottomSheetWrapper({
  snapPoints,
  initialSnap = 1,
  onDismiss,
  children,
}: BottomSheetWrapperProps) {
  const sheetRef = useRef<BottomSheet>(null);
  const theme = useTheme();

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
        opacity={0.3}
      />
    ),
    [],
  );

  return (
    <BottomSheet
      ref={sheetRef}
      index={initialSnap}
      snapPoints={snapPoints}
      enablePanDownToClose
      onClose={onDismiss}
      onChange={(index) => {
        if (index >= 0) Haptics.impactAsync(ImpactFeedbackStyle.Light);
      }}
      backdropComponent={renderBackdrop}
      handleComponent={Handle}
      backgroundStyle={[styles.background, { backgroundColor: theme.colors.surface }]}
      style={styles.sheet}
    >
      <BottomSheetScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  background: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  handleContainer: {
    alignItems: "center",
    paddingVertical: 10,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#ccc",
  },
});
