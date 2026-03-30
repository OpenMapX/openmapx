import { MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { authClient, oauthProviders } from "@openmapx/core";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, StyleSheet, View } from "react-native";
import {
  ActivityIndicator,
  Banner,
  Button,
  Divider,
  IconButton,
  Modal,
  Portal,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";

type AuthMode = "sign-in" | "sign-up" | "2fa" | "forgot-password" | "reset-password";

interface AuthDialogProps {
  visible: boolean;
  onDismiss: () => void;
}

export function AuthDialog({ visible, onDismiss }: AuthDialogProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 2FA state
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);

  // Password reset state
  const [resetOtp, setResetOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setEmail("");
    setPassword("");
    setName("");
    setError(null);
    setSuccessMessage(null);
    setShowPassword(false);
    setTotpCode("");
    setUseBackupCode(false);
    setResetOtp("");
    setNewPassword("");
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    setMode("sign-in");
    onDismiss();
  }, [resetForm, onDismiss]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === "sign-in" ? "sign-up" : "sign-in"));
    resetForm();
  }, [resetForm]);

  const handleEmailAuth = useCallback(async () => {
    Keyboard.dismiss();
    setLoading(true);
    setError(null);

    try {
      if (mode === "sign-up") {
        const { error: signUpError } = await authClient.signUp.email({
          email,
          password,
          name,
        });
        if (signUpError) {
          setError(signUpError.message ?? t("auth.signUpFailed"));
          return;
        }
      } else {
        const { data, error: signInError } = await authClient.signIn.email({
          email,
          password,
        });
        if (signInError) {
          setError(signInError.message ?? t("auth.signInFailed"));
          return;
        }
        if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
          setMode("2fa");
          setLoading(false);
          return;
        }
      }
      handleClose();
    } catch {
      setError(t("auth.signInFailed"));
    } finally {
      setLoading(false);
    }
  }, [mode, email, password, name, handleClose, t]);

  const handleVerifyTotp = useCallback(async () => {
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    try {
      if (useBackupCode) {
        const { error: backupError } = await authClient.twoFactor.verifyBackupCode({
          code: totpCode,
        });
        if (backupError) {
          setError(backupError.message ?? t("auth.invalidBackupCode"));
          return;
        }
      } else {
        const { error: totpError } = await authClient.twoFactor.verifyTotp({
          code: totpCode,
        });
        if (totpError) {
          setError(totpError.message ?? t("auth.signInFailed"));
          return;
        }
      }
      handleClose();
    } catch {
      setError(t("auth.verificationFailed"));
    } finally {
      setLoading(false);
    }
  }, [totpCode, useBackupCode, handleClose, t]);

  const handleForgotPassword = useCallback(async () => {
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    try {
      const { error: resetError } = await authClient.emailOtp.requestPasswordReset({
        email,
      });
      if (resetError) {
        setError(resetError.message ?? t("auth.failedSendResetCode"));
        return;
      }
      setMode("reset-password");
      setSuccessMessage(t("auth.verificationCodeSentEmail"));
    } catch {
      setError(t("auth.failedSendResetCode"));
    } finally {
      setLoading(false);
    }
  }, [email, t]);

  const handleResetPassword = useCallback(async () => {
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const { error: resetError } = await authClient.emailOtp.resetPassword({
        email,
        otp: resetOtp,
        password: newPassword,
      });
      if (resetError) {
        setError(resetError.message ?? t("auth.failedResetPassword"));
        return;
      }
      setSuccessMessage(t("auth.passwordResetSuccess"));
      setTimeout(() => {
        resetForm();
        setMode("sign-in");
      }, 1500);
    } catch {
      setError(t("auth.failedResetPassword"));
    } finally {
      setLoading(false);
    }
  }, [email, resetOtp, newPassword, resetForm, t]);

  const handlePasskeySignIn = useCallback(async () => {
    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    try {
      const { error: passkeyError } = await authClient.signIn.passkey();
      if (passkeyError) {
        if ("code" in passkeyError && passkeyError.code === "AUTH_CANCELLED") return;
        setError(String(passkeyError.message ?? t("auth.passkeySignInFailed")));
        return;
      }
      handleClose();
    } catch {
      setError(t("auth.passkeyAuthFailed"));
    } finally {
      setLoading(false);
    }
  }, [handleClose, t]);

  const handleOAuthSignIn = useCallback(
    async (providerId: string, providerName: string) => {
      setLoading(true);
      setError(null);
      try {
        await authClient.signIn.oauth2({
          providerId,
          callbackURL: "openmapx://",
        });
        handleClose();
      } catch {
        setError(t("auth.oauthSignInFailed", { provider: providerName }));
      } finally {
        setLoading(false);
      }
    },
    [handleClose, t],
  );

  const titleText =
    mode === "2fa"
      ? t("auth.twoStepVerification")
      : mode === "forgot-password"
        ? t("auth.accountRecovery")
        : mode === "reset-password"
          ? t("auth.resetPassword")
          : mode === "sign-in"
            ? t("auth.signIn")
            : t("auth.createAccount");

  const subtitleText =
    mode === "2fa"
      ? t("auth.enterCodeFromApp")
      : mode === "forgot-password"
        ? t("auth.enterEmailForReset")
        : mode === "reset-password"
          ? t("auth.enterCodeAndPassword")
          : mode === "sign-in"
            ? t("auth.useYourAccount")
            : t("auth.createYourAccount");

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={handleClose}
        contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Close button */}
          <View style={styles.closeRow}>
            <IconButton
              icon={({ size, color }) => <MaterialIcons name="close" size={size} color={color} />}
              size={20}
              onPress={handleClose}
            />
          </View>

          {/* Title */}
          <View style={styles.titleSection}>
            <Text variant="headlineSmall" style={styles.title}>
              {titleText}
            </Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              {subtitleText}
            </Text>
          </View>

          {/* Success message */}
          {successMessage && (
            <Banner visible icon="check-circle" style={styles.banner}>
              {successMessage}
            </Banner>
          )}

          {/* Error message */}
          {error && (
            <Banner
              visible
              icon="alert-circle"
              style={[styles.banner, { backgroundColor: theme.colors.errorContainer }]}
            >
              {error}
            </Banner>
          )}

          {/* Forgot password form */}
          {mode === "forgot-password" && (
            <View style={styles.form}>
              <TextInput
                label={t("auth.email")}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                mode="outlined"
                style={styles.input}
              />
              <Button
                mode="contained"
                onPress={handleForgotPassword}
                disabled={loading || !email}
                loading={loading}
                style={styles.submitButton}
              >
                {t("auth.sendResetCode")}
              </Button>
              <Button
                mode="text"
                onPress={() => {
                  setError(null);
                  setMode("sign-in");
                }}
              >
                {t("auth.backToSignIn")}
              </Button>
            </View>
          )}

          {/* Reset password form */}
          {mode === "reset-password" && (
            <View style={styles.form}>
              <TextInput
                label={t("auth.verificationCode")}
                value={resetOtp}
                onChangeText={setResetOtp}
                autoComplete="one-time-code"
                mode="outlined"
                style={styles.input}
              />
              <TextInput
                label={t("auth.newPassword")}
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry={!showPassword}
                autoComplete="new-password"
                mode="outlined"
                style={styles.input}
                right={
                  <TextInput.Icon
                    icon={showPassword ? "eye-off" : "eye"}
                    onPress={() => setShowPassword(!showPassword)}
                  />
                }
              />
              <Button
                mode="contained"
                onPress={handleResetPassword}
                disabled={loading || !resetOtp || !newPassword}
                loading={loading}
                style={styles.submitButton}
              >
                {t("auth.resetPassword")}
              </Button>
              <Button
                mode="text"
                onPress={() => {
                  setError(null);
                  setSuccessMessage(null);
                  setMode("sign-in");
                }}
              >
                {t("auth.backToSignIn")}
              </Button>
            </View>
          )}

          {/* 2FA form */}
          {mode === "2fa" && (
            <View style={styles.form}>
              <TextInput
                label={useBackupCode ? t("auth.backupCode") : t("auth.sixDigitCode")}
                value={totpCode}
                onChangeText={setTotpCode}
                autoComplete="one-time-code"
                keyboardType={useBackupCode ? "default" : "numeric"}
                maxLength={useBackupCode ? undefined : 6}
                mode="outlined"
                style={styles.input}
              />
              <Button
                mode="contained"
                onPress={handleVerifyTotp}
                disabled={loading || !totpCode}
                loading={loading}
                style={styles.submitButton}
              >
                {t("auth.verify")}
              </Button>
              <Button
                mode="text"
                onPress={() => {
                  setUseBackupCode(!useBackupCode);
                  setTotpCode("");
                  setError(null);
                }}
              >
                {useBackupCode ? t("auth.useAuthenticatorApp") : t("auth.useBackupCode")}
              </Button>
            </View>
          )}

          {/* Sign-in / Sign-up form */}
          {(mode === "sign-in" || mode === "sign-up") && (
            <View style={styles.form}>
              {mode === "sign-up" && (
                <TextInput
                  label={t("auth.name")}
                  value={name}
                  onChangeText={setName}
                  autoComplete="name"
                  mode="outlined"
                  style={styles.input}
                />
              )}
              <TextInput
                label={t("auth.email")}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                mode="outlined"
                style={styles.input}
              />
              <TextInput
                label={t("auth.password")}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                mode="outlined"
                style={styles.input}
                right={
                  <TextInput.Icon
                    icon={showPassword ? "eye-off" : "eye"}
                    onPress={() => setShowPassword(!showPassword)}
                  />
                }
              />

              {mode === "sign-in" && (
                <Button
                  mode="text"
                  onPress={() => {
                    setError(null);
                    setMode("forgot-password");
                  }}
                  compact
                  style={styles.forgotButton}
                >
                  {t("auth.forgotPassword")}
                </Button>
              )}

              <Button
                mode="contained"
                onPress={handleEmailAuth}
                disabled={loading}
                loading={loading}
                style={styles.submitButton}
              >
                {mode === "sign-in" ? t("auth.signIn") : t("auth.createAccount")}
              </Button>

              <Divider style={styles.divider} />

              {/* Passkey sign-in */}
              {mode === "sign-in" && (
                <Button
                  mode="outlined"
                  onPress={handlePasskeySignIn}
                  disabled={loading}
                  icon={({ size, color }) => (
                    <MaterialCommunityIcons name="key-variant" size={size} color={color} />
                  )}
                  style={styles.oauthButton}
                  labelStyle={{ color: theme.colors.onSurface }}
                >
                  {t("auth.signInWithPasskey")}
                </Button>
              )}

              {/* OAuth providers */}
              {oauthProviders.map((provider) => (
                <Button
                  key={provider.providerId}
                  mode="outlined"
                  onPress={() => handleOAuthSignIn(provider.providerId, provider.name)}
                  disabled={loading}
                  icon={({ size }) => (
                    <MaterialIcons
                      name="open-in-browser"
                      size={size}
                      color={theme.colors.onSurface}
                    />
                  )}
                  style={styles.oauthButton}
                  labelStyle={{ color: theme.colors.onSurface }}
                >
                  {t("auth.continueWith", { provider: provider.name })}
                </Button>
              ))}

              {/* Toggle sign-in / sign-up */}
              <View style={styles.toggleRow}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  {mode === "sign-in" ? t("auth.noAccount") : t("auth.haveAccount")}{" "}
                </Text>
                <Button mode="text" onPress={toggleMode} compact>
                  {mode === "sign-in" ? t("auth.createAccount") : t("auth.signIn")}
                </Button>
              </View>
            </View>
          )}

          {loading && <ActivityIndicator style={styles.loadingOverlay} />}
        </ScrollView>
      </Modal>
    </Portal>
  );
}

const styles = StyleSheet.create({
  modal: {
    marginHorizontal: 20,
    borderRadius: 16,
    maxHeight: "85%",
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  closeRow: {
    alignItems: "flex-end",
    marginTop: 4,
    marginRight: -12,
  },
  titleSection: {
    alignItems: "center",
    marginBottom: 16,
  },
  title: {
    fontWeight: "600",
    marginBottom: 4,
  },
  banner: {
    marginBottom: 12,
    borderRadius: 8,
  },
  form: {
    gap: 4,
  },
  input: {
    marginBottom: 8,
  },
  forgotButton: {
    alignSelf: "flex-start",
    marginBottom: 4,
  },
  submitButton: {
    marginTop: 8,
    marginBottom: 4,
    paddingVertical: 4,
  },
  divider: {
    marginVertical: 16,
  },
  oauthButton: {
    marginBottom: 8,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
    flexWrap: "wrap",
  },
  loadingOverlay: {
    marginTop: 8,
  },
});
