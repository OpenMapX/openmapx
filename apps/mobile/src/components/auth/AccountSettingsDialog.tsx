import { MaterialIcons } from "@expo/vector-icons";
import type { User } from "@openmapx/core";
import { authClient, getInitials, oauthProviders } from "@openmapx/core";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Share, StyleSheet, View } from "react-native";
import {
  Avatar,
  Banner,
  Button,
  Divider,
  IconButton,
  List,
  Modal,
  Portal,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import QRCode from "react-native-qrcode-svg";

interface AccountSettingsDialogProps {
  visible: boolean;
  onDismiss: () => void;
  user: User;
}

export function AccountSettingsDialog({ visible, onDismiss, user }: AccountSettingsDialogProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Email change state
  const [changingEmail, setChangingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [emailOtpSent, setEmailOtpSent] = useState(false);

  // Password change state
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  // 2FA state
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [totpSetupUri, setTotpSetupUri] = useState<string | null>(null);
  const [totpVerifyCode, setTotpVerifyCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [showDisable2fa, setShowDisable2fa] = useState(false);
  const [showBackupCodes, setShowBackupCodes] = useState(false);

  // Passkeys
  const [passkeys, setPasskeys] = useState<
    { id: string; name?: string | null; createdAt?: Date | null }[]
  >([]);

  // Linked accounts
  const [linkedAccounts, setLinkedAccounts] = useState<{ providerId: string; accountId: string }[]>(
    [],
  );

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");

  useEffect(() => {
    if (!visible) return;
    setName(user.name);
    setMessage(null);
    setChangingEmail(false);
    setNewEmail("");
    setEmailOtp("");
    setEmailOtpSent(false);
    setChangingPassword(false);
    setCurrentPassword("");
    setNewPassword("");
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setConfirmDelete(false);
    setDeletePassword("");
    setShowTwoFactorSetup(false);
    setShowDisable2fa(false);
    setShowBackupCodes(false);
    setTotpSetupUri(null);
    setBackupCodes(null);
    setTwoFactorPassword("");
    setTotpVerifyCode("");
    setTwoFactorEnabled(!!(user as Record<string, unknown>).twoFactorEnabled);

    authClient.listAccounts().then(({ data }) => {
      if (data) {
        setLinkedAccounts(
          data.map((a: { providerId: string; accountId: string }) => ({
            providerId: a.providerId,
            accountId: a.accountId,
          })),
        );
      }
    });

    authClient.passkey.listUserPasskeys().then(({ data }) => {
      if (data) setPasskeys(data);
    });
  }, [visible, user.name, (user as Record<string, unknown>).twoFactorEnabled]);

  // Profile
  const handleUpdateProfile = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await authClient.updateUser({ name });
      if (error) {
        setMessage({ type: "error", text: error.message ?? t("account.updateFailed") });
      } else {
        setMessage({ type: "success", text: t("account.profileUpdated") });
      }
    } catch {
      setMessage({ type: "error", text: t("account.unexpectedError") });
    } finally {
      setSaving(false);
    }
  }, [name, t]);

  // Email change
  const handleRequestEmailChange = useCallback(async () => {
    setMessage(null);
    try {
      const { error } = await authClient.emailOtp.requestEmailChange({ newEmail });
      if (error) {
        setMessage({ type: "error", text: error.message ?? t("account.failedChangeEmail") });
        return;
      }
      setEmailOtpSent(true);
      setMessage({ type: "success", text: t("account.verificationCodeSent") });
    } catch {
      setMessage({ type: "error", text: t("account.failedChangeEmail") });
    }
  }, [newEmail, t]);

  const handleConfirmEmailChange = useCallback(async () => {
    setMessage(null);
    try {
      const { error } = await authClient.emailOtp.changeEmail({ newEmail, otp: emailOtp });
      if (error) {
        setMessage({ type: "error", text: error.message ?? t("account.failedChangeEmail") });
        return;
      }
      setMessage({ type: "success", text: t("account.emailUpdated") });
      setChangingEmail(false);
      setNewEmail("");
      setEmailOtp("");
      setEmailOtpSent(false);
    } catch {
      setMessage({ type: "error", text: t("account.failedChangeEmail") });
    }
  }, [newEmail, emailOtp, t]);

  // Password
  const handleChangePassword = useCallback(async () => {
    setMessage(null);
    try {
      const { error } = await authClient.changePassword({ currentPassword, newPassword });
      if (error) {
        setMessage({ type: "error", text: error.message ?? t("account.failedChangePassword") });
        return;
      }
      setMessage({ type: "success", text: t("account.passwordChanged") });
      setChangingPassword(false);
      setCurrentPassword("");
      setNewPassword("");
    } catch {
      setMessage({ type: "error", text: t("account.failedChangePassword") });
    }
  }, [currentPassword, newPassword, t]);

  // 2FA
  const handleEnable2FA = useCallback(async () => {
    setMessage(null);
    try {
      const { data, error } = await authClient.twoFactor.enable({
        password: twoFactorPassword,
      });
      if (error) {
        setMessage({ type: "error", text: error.message ?? t("account.failedEnable2FA") });
        return;
      }
      if (data) {
        setTotpSetupUri(data.totpURI);
        setBackupCodes(data.backupCodes);
      }
    } catch {
      setMessage({ type: "error", text: t("account.failedEnable2FA") });
    }
  }, [twoFactorPassword, t]);

  const handleVerifyTotpSetup = useCallback(async () => {
    setMessage(null);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code: totpVerifyCode });
      if (error) {
        setMessage({ type: "error", text: error.message ?? t("account.invalidCode") });
        return;
      }
      setTwoFactorEnabled(true);
      setShowTwoFactorSetup(false);
      setTotpSetupUri(null);
      setTwoFactorPassword("");
      setTotpVerifyCode("");
      setMessage({ type: "success", text: t("account.twoFAEnabled2") });
    } catch {
      setMessage({ type: "error", text: t("account.failedVerifyCode") });
    }
  }, [totpVerifyCode, t]);

  const handleDisable2FA = useCallback(async () => {
    setMessage(null);
    try {
      const { error } = await authClient.twoFactor.disable({ password: twoFactorPassword });
      if (error) {
        setMessage({ type: "error", text: error.message ?? t("account.failedDisable2FA") });
        return;
      }
      setTwoFactorEnabled(false);
      setShowDisable2fa(false);
      setTwoFactorPassword("");
      setBackupCodes(null);
      setMessage({ type: "success", text: t("account.twoFADisabled") });
    } catch {
      setMessage({ type: "error", text: t("account.failedDisable2FA") });
    }
  }, [twoFactorPassword, t]);

  const handleRegenerateBackupCodes = useCallback(async () => {
    setMessage(null);
    try {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({
        password: twoFactorPassword,
      });
      if (error) {
        setMessage({
          type: "error",
          text: error.message ?? t("account.failedGenerateBackupCodes"),
        });
        return;
      }
      if (data) {
        setBackupCodes(data.backupCodes);
        setMessage({ type: "success", text: t("account.newBackupCodesGenerated") });
      }
    } catch {
      setMessage({ type: "error", text: t("account.failedGenerateBackupCodes") });
    }
  }, [twoFactorPassword, t]);

  const handleCopyBackupCodes = useCallback(async () => {
    if (backupCodes) {
      await Clipboard.setStringAsync(backupCodes.join("\n"));
      setMessage({ type: "success", text: t("account.backupCodesCopied") });
    }
  }, [backupCodes, t]);

  const handleShareBackupCodes = useCallback(async () => {
    if (!backupCodes) return;
    const content = `OpenMapX Backup Codes\n${"=".repeat(22)}\n\n${backupCodes.join("\n")}\n\nEach code can only be used once.\nStore these codes in a safe place.\n`;
    await Share.share({ message: content, title: "OpenMapX Backup Codes" });
  }, [backupCodes]);

  // Passkeys
  const handleAddPasskey = useCallback(async () => {
    setMessage(null);
    try {
      const { error } = await authClient.passkey.addPasskey();
      if (error) {
        const msg = typeof error === "string" ? error : (error as { message?: string }).message;
        setMessage({ type: "error", text: msg ?? t("account.failedAddPasskey") });
        return;
      }
      setMessage({ type: "success", text: t("account.passkeyAdded") });
      const { data } = await authClient.passkey.listUserPasskeys();
      if (data) setPasskeys(data);
    } catch {
      setMessage({ type: "error", text: t("account.failedAddPasskey") });
    }
  }, [t]);

  const handleDeletePasskey = useCallback(
    async (id: string) => {
      try {
        await authClient.passkey.deletePasskey({ id });
        setPasskeys((prev) => prev.filter((p) => p.id !== id));
        setMessage({ type: "success", text: t("account.passkeyRemoved") });
      } catch {
        setMessage({ type: "error", text: t("account.failedRemovePasskey") });
      }
    },
    [t],
  );

  // Connected accounts
  const handleLinkAccount = useCallback(
    async (providerId: string, providerName: string) => {
      setMessage(null);
      try {
        await authClient.signIn.oauth2({ providerId, callbackURL: "openmapx://" });
      } catch {
        setMessage({
          type: "error",
          text: t("account.failedLink", { provider: providerName }),
        });
      }
    },
    [t],
  );

  const handleUnlinkAccount = useCallback(
    async (providerId: string, providerName: string) => {
      setMessage(null);
      try {
        await authClient.unlinkAccount({ providerId });
        setLinkedAccounts((prev) => prev.filter((a) => a.providerId !== providerId));
        setMessage({
          type: "success",
          text: t("account.accountUnlinked", { provider: providerName }),
        });
      } catch {
        setMessage({
          type: "error",
          text: t("account.failedUnlink", { provider: providerName }),
        });
      }
    },
    [t],
  );

  // Delete account
  const hasCredential = linkedAccounts.some((a) => a.providerId === "credential");

  const handleDeleteAccount = useCallback(async () => {
    try {
      const { error } = await authClient.deleteUser(
        hasCredential ? { password: deletePassword } : { callbackURL: "openmapx://" },
      );
      if (error) {
        setMessage({
          type: "error",
          text: error.message ?? t("account.failedDeleteAccount"),
        });
        return;
      }
      onDismiss();
    } catch {
      setMessage({ type: "error", text: t("account.failedDeleteAccount") });
    }
  }, [deletePassword, hasCredential, onDismiss, t]);

  const initials = getInitials(user.name, user.email);

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Header */}
          <View style={styles.headerRow}>
            <Text variant="titleLarge" style={styles.headerTitle}>
              {t("account.accountSettings")}
            </Text>
            <IconButton
              icon={({ size, color }) => <MaterialIcons name="close" size={size} color={color} />}
              size={20}
              onPress={onDismiss}
            />
          </View>

          {/* Status messages */}
          {message && (
            <Banner
              visible
              icon={message.type === "success" ? "check-circle" : "alert-circle"}
              style={[
                styles.banner,
                message.type === "error" && {
                  backgroundColor: theme.colors.errorContainer,
                },
              ]}
            >
              {message.text}
            </Banner>
          )}

          {/* Profile section */}
          <List.Section>
            <List.Subheader>{t("account.profile")}</List.Subheader>
            <View style={styles.profileRow}>
              {user.image ? (
                <Avatar.Image size={48} source={{ uri: user.image }} />
              ) : (
                <Avatar.Text
                  size={48}
                  label={initials}
                  style={{ backgroundColor: theme.colors.primary }}
                />
              )}
              <View style={styles.profileInfo}>
                <Text variant="bodyLarge" style={styles.profileName} numberOfLines={1}>
                  {user.name}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{ color: theme.colors.onSurfaceVariant }}
                  numberOfLines={1}
                >
                  {user.email}
                </Text>
              </View>
            </View>

            <TextInput
              label={t("account.name")}
              value={name}
              onChangeText={setName}
              mode="outlined"
              style={styles.input}
            />
            <Button
              mode="contained"
              onPress={handleUpdateProfile}
              disabled={saving || name === user.name}
              loading={saving}
              style={styles.actionButton}
            >
              {t("account.saveChanges")}
            </Button>
          </List.Section>

          <Divider />

          {/* Email section */}
          <List.Section>
            <List.Subheader>{t("account.emailAddress")}</List.Subheader>
            {!changingEmail ? (
              <View style={styles.emailRow}>
                <Text
                  variant="bodyMedium"
                  style={[styles.emailText, { color: theme.colors.onSurfaceVariant }]}
                  numberOfLines={1}
                >
                  {user.email}
                </Text>
                <Button
                  mode="text"
                  compact
                  onPress={() => setChangingEmail(true)}
                  icon={({ size, color }) => (
                    <MaterialIcons name="edit" size={size} color={color} />
                  )}
                >
                  {t("common.change")}
                </Button>
              </View>
            ) : (
              <View style={styles.formSection}>
                <TextInput
                  label={t("account.newEmailAddress")}
                  value={newEmail}
                  onChangeText={setNewEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  mode="outlined"
                  style={styles.input}
                />
                {emailOtpSent && (
                  <TextInput
                    label={t("account.verificationCode")}
                    value={emailOtp}
                    onChangeText={setEmailOtp}
                    keyboardType="number-pad"
                    mode="outlined"
                    style={styles.input}
                  />
                )}
                <View style={styles.buttonRow}>
                  <Button
                    mode="text"
                    onPress={() => {
                      setChangingEmail(false);
                      setNewEmail("");
                      setEmailOtp("");
                      setEmailOtpSent(false);
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                  {!emailOtpSent ? (
                    <Button
                      mode="contained"
                      onPress={handleRequestEmailChange}
                      disabled={!newEmail}
                    >
                      {t("account.sendVerificationCode")}
                    </Button>
                  ) : (
                    <Button
                      mode="contained"
                      onPress={handleConfirmEmailChange}
                      disabled={!emailOtp}
                    >
                      {t("account.confirmChange")}
                    </Button>
                  )}
                </View>
              </View>
            )}
          </List.Section>

          <Divider />

          {/* Password section */}
          <List.Section>
            <List.Subheader>{t("account.password")}</List.Subheader>
            {changingPassword ? (
              <View style={styles.formSection}>
                <TextInput
                  label={t("account.currentPassword")}
                  value={currentPassword}
                  onChangeText={setCurrentPassword}
                  secureTextEntry={!showCurrentPassword}
                  mode="outlined"
                  style={styles.input}
                  right={
                    <TextInput.Icon
                      icon={showCurrentPassword ? "eye-off" : "eye"}
                      onPress={() => setShowCurrentPassword(!showCurrentPassword)}
                    />
                  }
                />
                <TextInput
                  label={t("account.newPassword")}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  secureTextEntry={!showNewPassword}
                  mode="outlined"
                  style={styles.input}
                  right={
                    <TextInput.Icon
                      icon={showNewPassword ? "eye-off" : "eye"}
                      onPress={() => setShowNewPassword(!showNewPassword)}
                    />
                  }
                />
                <View style={styles.buttonRow}>
                  <Button mode="text" onPress={() => setChangingPassword(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    mode="contained"
                    onPress={handleChangePassword}
                    disabled={!currentPassword || !newPassword}
                  >
                    {t("account.updatePassword")}
                  </Button>
                </View>
              </View>
            ) : (
              <Button
                mode="outlined"
                onPress={() => setChangingPassword(true)}
                style={styles.actionButton}
                icon={({ size, color }) => <MaterialIcons name="lock" size={size} color={color} />}
              >
                {t("account.changePassword")}
              </Button>
            )}
          </List.Section>

          <Divider />

          {/* Two-Factor Authentication */}
          <List.Section>
            <List.Subheader>{t("account.twoFactorAuth")}</List.Subheader>
            {twoFactorEnabled ? (
              <View style={styles.formSection}>
                <View style={styles.twoFaStatusRow}>
                  <MaterialIcons name="verified-user" size={20} color={theme.colors.primary} />
                  <Text
                    variant="bodyMedium"
                    style={{ color: theme.colors.primary, flex: 1, marginLeft: 8 }}
                  >
                    {t("account.twoFAEnabled")}
                  </Text>
                </View>

                {!showBackupCodes && !showDisable2fa && (
                  <View style={styles.buttonRow}>
                    <Button
                      mode="outlined"
                      onPress={() => {
                        setShowBackupCodes(true);
                        setShowDisable2fa(false);
                        setTwoFactorPassword("");
                        setBackupCodes(null);
                      }}
                      icon={({ size, color }) => (
                        <MaterialIcons name="vpn-key" size={size} color={color} />
                      )}
                    >
                      {t("account.backupCodes")}
                    </Button>
                    <Button
                      mode="text"
                      textColor={theme.colors.error}
                      onPress={() => {
                        setShowDisable2fa(true);
                        setShowBackupCodes(false);
                        setTwoFactorPassword("");
                        setBackupCodes(null);
                      }}
                    >
                      {t("account.disable2FA")}
                    </Button>
                  </View>
                )}

                {/* Backup codes panel */}
                {showBackupCodes && (
                  <View>
                    {!backupCodes ? (
                      <>
                        <Text variant="bodySmall" style={styles.helperText}>
                          {t("account.enterPasswordToRegenerate")}
                        </Text>
                        <TextInput
                          label={t("account.password")}
                          value={twoFactorPassword}
                          onChangeText={setTwoFactorPassword}
                          secureTextEntry
                          mode="outlined"
                          style={styles.input}
                        />
                        <View style={styles.buttonRow}>
                          <Button
                            mode="text"
                            onPress={() => {
                              setShowBackupCodes(false);
                              setTwoFactorPassword("");
                            }}
                          >
                            {t("common.cancel")}
                          </Button>
                          <Button
                            mode="contained"
                            onPress={handleRegenerateBackupCodes}
                            disabled={!twoFactorPassword}
                          >
                            {t("account.regenerateCodes")}
                          </Button>
                        </View>
                      </>
                    ) : (
                      <>
                        <Text variant="bodySmall" style={styles.helperText}>
                          {t("account.saveBackupCodes")}
                        </Text>
                        <View
                          style={[
                            styles.codeBlock,
                            { backgroundColor: theme.colors.surfaceVariant },
                          ]}
                        >
                          {backupCodes.map((code) => (
                            <Text key={code} style={styles.codeText}>
                              {code}
                            </Text>
                          ))}
                        </View>
                        <View style={styles.buttonRow}>
                          <Button
                            mode="text"
                            onPress={handleCopyBackupCodes}
                            icon={({ size, color }) => (
                              <MaterialIcons name="content-copy" size={size} color={color} />
                            )}
                          >
                            {t("common.copy")}
                          </Button>
                          <Button
                            mode="text"
                            onPress={handleShareBackupCodes}
                            icon={({ size, color }) => (
                              <MaterialIcons name="share" size={size} color={color} />
                            )}
                          >
                            {t("common.share")}
                          </Button>
                          <Button
                            mode="outlined"
                            onPress={() => {
                              setShowBackupCodes(false);
                              setBackupCodes(null);
                              setTwoFactorPassword("");
                            }}
                          >
                            {t("common.done")}
                          </Button>
                        </View>
                      </>
                    )}
                  </View>
                )}

                {/* Disable 2FA confirmation */}
                {showDisable2fa && (
                  <View>
                    <Text
                      variant="bodySmall"
                      style={[styles.helperText, { color: theme.colors.error }]}
                    >
                      {t("account.enterPasswordToDisable")}
                    </Text>
                    <TextInput
                      label={t("account.password")}
                      value={twoFactorPassword}
                      onChangeText={setTwoFactorPassword}
                      secureTextEntry
                      mode="outlined"
                      style={styles.input}
                    />
                    <View style={styles.buttonRow}>
                      <Button
                        mode="text"
                        onPress={() => {
                          setShowDisable2fa(false);
                          setTwoFactorPassword("");
                        }}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        mode="contained"
                        buttonColor={theme.colors.error}
                        onPress={handleDisable2FA}
                        disabled={!twoFactorPassword}
                      >
                        {t("account.disable2FA")}
                      </Button>
                    </View>
                  </View>
                )}
              </View>
            ) : !showTwoFactorSetup ? (
              <View style={styles.formSection}>
                <Text
                  variant="bodySmall"
                  style={[styles.helperText, { color: theme.colors.onSurfaceVariant }]}
                >
                  {t("account.twoFADescription")}
                </Text>
                <Button
                  mode="outlined"
                  onPress={() => setShowTwoFactorSetup(true)}
                  style={styles.actionButton}
                  icon={({ size, color }) => (
                    <MaterialIcons name="security" size={size} color={color} />
                  )}
                >
                  {t("account.setUp2FA")}
                </Button>
              </View>
            ) : (
              <View style={styles.formSection}>
                {!totpSetupUri ? (
                  <>
                    <Text variant="bodySmall" style={styles.helperText}>
                      {t("account.enterPasswordToSetup")}
                    </Text>
                    <TextInput
                      label={t("account.password")}
                      value={twoFactorPassword}
                      onChangeText={setTwoFactorPassword}
                      secureTextEntry
                      mode="outlined"
                      style={styles.input}
                    />
                    <View style={styles.buttonRow}>
                      <Button
                        mode="text"
                        onPress={() => {
                          setShowTwoFactorSetup(false);
                          setTwoFactorPassword("");
                        }}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        mode="contained"
                        onPress={handleEnable2FA}
                        disabled={!twoFactorPassword}
                      >
                        {t("common.continue")}
                      </Button>
                    </View>
                  </>
                ) : (
                  <>
                    <Text variant="bodySmall" style={styles.helperText}>
                      {t("account.scanQRCode")}
                    </Text>
                    <View style={styles.qrContainer}>
                      <QRCode value={totpSetupUri} size={200} />
                    </View>
                    <Text
                      variant="labelSmall"
                      style={[styles.totpUri, { color: theme.colors.onSurfaceVariant }]}
                      selectable
                    >
                      {totpSetupUri}
                    </Text>

                    {/* Show backup codes during setup */}
                    {backupCodes && (
                      <View style={styles.backupCodesSetup}>
                        <Text variant="titleSmall" style={{ fontWeight: "600" }}>
                          {t("account.backupCodesTitle")}
                        </Text>
                        <Text variant="bodySmall" style={styles.helperText}>
                          {t("account.saveCodesDescription")}
                        </Text>
                        <View
                          style={[
                            styles.codeBlock,
                            { backgroundColor: theme.colors.surfaceVariant },
                          ]}
                        >
                          {backupCodes.map((code) => (
                            <Text key={code} style={styles.codeText}>
                              {code}
                            </Text>
                          ))}
                        </View>
                        <View style={styles.buttonRow}>
                          <Button
                            mode="text"
                            onPress={handleCopyBackupCodes}
                            icon={({ size, color }) => (
                              <MaterialIcons name="content-copy" size={size} color={color} />
                            )}
                          >
                            {t("common.copy")}
                          </Button>
                          <Button
                            mode="text"
                            onPress={handleShareBackupCodes}
                            icon={({ size, color }) => (
                              <MaterialIcons name="share" size={size} color={color} />
                            )}
                          >
                            {t("common.share")}
                          </Button>
                        </View>
                      </View>
                    )}

                    <Text variant="bodySmall" style={styles.helperText}>
                      {t("account.enterCodeToVerify")}
                    </Text>
                    <TextInput
                      label={t("account.verificationCode")}
                      value={totpVerifyCode}
                      onChangeText={setTotpVerifyCode}
                      keyboardType="number-pad"
                      maxLength={6}
                      mode="outlined"
                      style={styles.input}
                    />
                    <View style={styles.buttonRow}>
                      <Button
                        mode="text"
                        onPress={() => {
                          setShowTwoFactorSetup(false);
                          setTotpSetupUri(null);
                          setBackupCodes(null);
                          setTwoFactorPassword("");
                          setTotpVerifyCode("");
                        }}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        mode="contained"
                        onPress={handleVerifyTotpSetup}
                        disabled={totpVerifyCode.length < 6}
                      >
                        {t("account.verifyAndEnable")}
                      </Button>
                    </View>
                  </>
                )}
              </View>
            )}
          </List.Section>

          <Divider />

          {/* Connected accounts */}
          <List.Section>
            <List.Subheader>{t("account.connectedAccounts")}</List.Subheader>
            {oauthProviders.map((provider) => {
              const isLinked = linkedAccounts.some((a) => a.providerId === provider.providerId);
              return (
                <List.Item
                  key={provider.providerId}
                  title={provider.name}
                  description={isLinked ? t("account.connected") : t("account.notConnected")}
                  left={(props) => (
                    <List.Icon
                      {...props}
                      icon={({ size, color }) => (
                        <MaterialIcons
                          name={isLinked ? "link" : "link-off"}
                          size={size}
                          color={color}
                        />
                      )}
                    />
                  )}
                  right={() =>
                    isLinked ? (
                      <Button
                        mode="text"
                        compact
                        onPress={() => handleUnlinkAccount(provider.providerId, provider.name)}
                      >
                        {t("account.unlink")}
                      </Button>
                    ) : (
                      <Button
                        mode="text"
                        compact
                        onPress={() => handleLinkAccount(provider.providerId, provider.name)}
                      >
                        {t("account.connect")}
                      </Button>
                    )
                  }
                />
              );
            })}
          </List.Section>

          <Divider />

          {/* Passkeys */}
          <List.Section>
            <List.Subheader>{t("account.passkeys")}</List.Subheader>
            {passkeys.length > 0 ? (
              passkeys.map((pk) => (
                <List.Item
                  key={pk.id}
                  title={pk.name ?? t("account.passkey")}
                  description={
                    pk.createdAt
                      ? t("account.addedDate", {
                          date: new Date(pk.createdAt).toLocaleDateString(),
                        })
                      : undefined
                  }
                  left={(props) => (
                    <List.Icon
                      {...props}
                      icon={({ size, color }) => (
                        <MaterialIcons name="fingerprint" size={size} color={color} />
                      )}
                    />
                  )}
                  right={() => (
                    <IconButton
                      icon={({ size, color }) => (
                        <MaterialIcons name="delete" size={size} color={color} />
                      )}
                      size={20}
                      onPress={() => handleDeletePasskey(pk.id)}
                    />
                  )}
                />
              ))
            ) : (
              <Text
                variant="bodySmall"
                style={[styles.helperText, { color: theme.colors.onSurfaceVariant }]}
              >
                {t("account.noPasskeys")}
              </Text>
            )}
            <Button
              mode="outlined"
              onPress={handleAddPasskey}
              style={styles.actionButton}
              icon={({ size, color }) => <MaterialIcons name="vpn-key" size={size} color={color} />}
            >
              {t("account.addPasskey")}
            </Button>
          </List.Section>

          <Divider />

          {/* Danger zone */}
          <List.Section>
            <List.Subheader style={{ color: theme.colors.error }}>
              {t("account.dangerZone")}
            </List.Subheader>
            {!confirmDelete ? (
              <Button
                mode="outlined"
                onPress={() => setConfirmDelete(true)}
                textColor={theme.colors.error}
                style={[styles.deleteButton, { borderColor: theme.colors.error }]}
                icon={({ size }) => (
                  <MaterialIcons name="delete-forever" size={size} color={theme.colors.error} />
                )}
              >
                {t("account.deleteAccount")}
              </Button>
            ) : (
              <View style={styles.formSection}>
                <Text
                  variant="bodySmall"
                  style={[styles.dangerText, { color: theme.colors.error }]}
                >
                  {t("account.deleteAccountWarning")}
                </Text>
                {hasCredential && (
                  <TextInput
                    label={t("account.password")}
                    value={deletePassword}
                    onChangeText={setDeletePassword}
                    secureTextEntry
                    mode="outlined"
                    style={styles.input}
                  />
                )}
                <View style={styles.buttonRow}>
                  <Button
                    mode="text"
                    onPress={() => {
                      setConfirmDelete(false);
                      setDeletePassword("");
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    mode="contained"
                    onPress={handleDeleteAccount}
                    buttonColor={theme.colors.error}
                    textColor={theme.colors.onError}
                    disabled={hasCredential && !deletePassword}
                  >
                    {t("account.confirmDeletion")}
                  </Button>
                </View>
              </View>
            )}
          </List.Section>
        </ScrollView>
      </Modal>
    </Portal>
  );
}

const styles = StyleSheet.create({
  modal: {
    marginHorizontal: 20,
    borderRadius: 16,
    maxHeight: "90%",
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    paddingLeft: 8,
  },
  headerTitle: {
    fontWeight: "600",
  },
  banner: {
    marginBottom: 8,
    borderRadius: 8,
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 8,
  },
  profileInfo: {
    flex: 1,
    minWidth: 0,
  },
  profileName: {
    fontWeight: "600",
  },
  emailRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  emailText: {
    flex: 1,
  },
  input: {
    marginHorizontal: 16,
    marginBottom: 8,
  },
  actionButton: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
  },
  formSection: {
    paddingHorizontal: 0,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
  },
  helperText: {
    marginHorizontal: 16,
    marginBottom: 8,
  },
  twoFaStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  qrContainer: {
    alignItems: "center",
    marginVertical: 12,
  },
  totpUri: {
    marginHorizontal: 16,
    marginBottom: 12,
    fontSize: 10,
  },
  backupCodesSetup: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  codeBlock: {
    borderRadius: 8,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  codeText: {
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 20,
  },
  dangerText: {
    marginHorizontal: 16,
    marginBottom: 8,
  },
  deleteButton: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 8,
  },
});
