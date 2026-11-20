"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import SupervisorAccountIcon from "@mui/icons-material/SupervisorAccount";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { getInitials, proxyImageUrl } from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useAdminDraftExit } from "@/lib/admin/AdminDraftProvider";
import { useAccountAction, useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useAccountErrorText } from "@/lib/admin/useAccountErrorText";
import { useAdminTab } from "@/lib/admin/useAdminQueryState";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useClientPagination } from "../shared/tableHooks";
import { AccountRecoveryActions } from "./AccountRecoveryActions";
import { BanUserDialog } from "./BanUserDialog";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  twoFactorEnabled?: boolean | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function ProfileTab({
  user,
  isSelf,
  impersonate,
}: {
  user: AdminUser;
  isSelf: boolean;
  impersonate: { mutate: () => void; isPending: boolean; error: Error | null };
}) {
  const t = useTranslations("adminUsers");
  const errorText = useAccountErrorText();
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<string>(user.role ?? "user");
  const [banOpen, setBanOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const avatarSrc = user.image ? proxyImageUrl(user.image) : undefined;

  const dirty = name !== user.name || email !== user.email || role !== (user.role ?? "user");

  const updateUser = useAccountAction(user.id);
  const unban = useAccountAction(user.id);
  const deleteUser = useAccountAction(user.id, { onSuccess: () => router.push("/admin/users") });

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      {(updateUser.error || impersonate.error || unban.error || deleteUser.error) && (
        <Alert severity="error">
          {errorText(updateUser.error || impersonate.error || unban.error || deleteUser.error)}
        </Alert>
      )}
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          gap: 2,
        }}
      >
        <Avatar
          src={avatarSrc}
          sx={{ width: 56, height: 56, fontSize: 20, bgcolor: "primary.main" }}
        >
          {!user.image && getInitials(user.name, user.email)}
        </Avatar>
        <Box>
          <Typography
            variant="h6"
            sx={{
              fontWeight: 600,
            }}
          >
            {user.name}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {user.email}
          </Typography>
        </Box>
      </Stack>
      <Divider />
      <Stack
        sx={{
          gap: 2,
          maxWidth: 480,
        }}
      >
        <TextField
          label={t("fullName")}
          value={name}
          disabled={updateUser.isPending}
          onChange={(e) => setName(e.target.value)}
          size="small"
        />
        <TextField
          label={t("email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          size="small"
          disabled
          helperText={t("emailChangesMustBeMade")}
        />
        <FormControl size="small">
          <InputLabel>{t("role")}</InputLabel>
          <Select
            inputProps={{ "aria-label": t("role") }}
            value={role}
            label={t("role")}
            onChange={(e) => setRole(e.target.value)}
            disabled={isSelf || updateUser.isPending}
          >
            <MenuItem value="user">{t("user")}</MenuItem>
            <MenuItem value="admin">{t("admin")}</MenuItem>
          </Select>
        </FormControl>
        {dirty && (
          <Button
            variant="contained"
            size="small"
            sx={{ alignSelf: "flex-start" }}
            onClick={() =>
              updateUser.mutate(async (client) => {
                if (name !== user.name) await client.updateName(user.id, name);
                if (role !== (user.role ?? "user"))
                  await client.changeRole(user.id, role, user.role ?? "user");
              })
            }
            disabled={updateUser.isPending}
          >
            {t("saveChanges")}
          </Button>
        )}
      </Stack>
      <Divider />
      <Box>
        <Typography
          variant="subtitle2"
          gutterBottom
          sx={{
            color: "text.secondary",
          }}
        >
          {t("readOnly")}
        </Typography>
        <Stack
          sx={{
            gap: 0.5,
          }}
        >
          <Typography variant="body2">
            <strong>{t("id")}</strong> {user.id}
          </Typography>
          <Typography variant="body2">
            <strong>{t("joined")}</strong> {new Date(user.createdAt).toLocaleString()}
          </Typography>
          <Typography variant="body2">
            <strong>{t("updated")}</strong> {new Date(user.updatedAt).toLocaleString()}
          </Typography>
          <Typography variant="body2" component="div">
            <strong>{t("emailVerified")}</strong>{" "}
            {user.emailVerified ? (
              <Chip label={t("yes")} size="small" color="success" />
            ) : (
              <Chip label={t("no")} size="small" />
            )}
          </Typography>
          <Typography variant="body2" component="div">
            <strong>{t("n2fa")}</strong>{" "}
            {user.twoFactorEnabled ? (
              <Chip label={t("enabled")} size="small" color="primary" />
            ) : (
              <Chip label={t("disabled")} size="small" />
            )}
          </Typography>
          {user.banned && (
            <Typography variant="body2">
              <strong>{t("banReason")}</strong> {user.banReason ?? "—"}
            </Typography>
          )}
        </Stack>
      </Box>
      <Divider />
      <AccountRecoveryActions user={user} />
      <Divider />
      <Stack
        direction="row"
        sx={{
          gap: 1,
          flexWrap: "wrap",
        }}
      >
        {!isSelf && (
          <Button
            startIcon={<SupervisorAccountIcon />}
            variant="outlined"
            size="small"
            onClick={impersonate.mutate}
            disabled={impersonate.isPending}
          >
            {t("impersonate")}
          </Button>
        )}
        {user.banned ? (
          <Button
            startIcon={<CheckCircleIcon />}
            variant="outlined"
            size="small"
            onClick={() => unban.mutate((client) => client.unban(user.id))}
            disabled={unban.isPending}
          >
            {t("unban")}
          </Button>
        ) : (
          !isSelf && (
            <Button
              startIcon={<BlockIcon />}
              variant="outlined"
              size="small"
              color="warning"
              onClick={() => setBanOpen(true)}
            >
              {t("ban")}
            </Button>
          )
        )}
        {!isSelf && (
          <Button
            startIcon={<DeleteIcon />}
            variant="outlined"
            size="small"
            color="error"
            onClick={() => setDeleteOpen(true)}
            disabled={deleteUser.isPending}
          >
            {t("deleteAccount")}
          </Button>
        )}
      </Stack>
      {banOpen && <BanUserDialog user={user} onClose={() => setBanOpen(false)} />}
      <ConfirmDialog
        open={deleteOpen}
        title={t("deleteUserAccount")}
        message={t("areYouSureYouWant", { name: user.name })}
        confirmLabel={t("delete")}
        confirmColor="error"
        loading={deleteUser.isPending}
        onConfirm={() => deleteUser.mutate((client) => client.remove(user.id))}
        onCancel={() => setDeleteOpen(false)}
      />
    </Stack>
  );
}

function SessionsTab({ userId }: { userId: string }) {
  const t = useTranslations("adminUsers");
  const errorText = useAccountErrorText();
  const account = useAccountAdmin();
  const { data, isLoading, error } = useQuery({
    queryKey: account.keys.sessions(userId),
    enabled: Boolean(account.actorId),
    retry: false,
    queryFn: ({ signal }) => account.client.sessions(userId, signal),
  });
  const revoke = useAccountAction(userId),
    revokeAll = useAccountAction(userId);

  const sessions = data ?? [];
  const { paged, paginationProps } = useClientPagination(sessions);

  if (isLoading) return <CircularProgress size={24} sx={{ mt: 2 }} />;

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {(error || revoke.error || revokeAll.error) && (
        <Alert severity="error">
          {error ? t("couldNotLoadSessions") : errorText(revoke.error || revokeAll.error)}
        </Alert>
      )}
      <Stack
        direction="row"
        sx={{
          justifyContent: "flex-end",
        }}
      >
        <Button
          variant="outlined"
          size="small"
          color="warning"
          onClick={() => revokeAll.mutate((client) => client.revokeAll(userId))}
          disabled={revokeAll.isPending || (data?.length ?? 0) === 0}
        >
          {t("revokeAllSessions")}
        </Button>
      </Stack>
      <Paper variant="outlined">
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t("ipAddress")}</TableCell>
                <TableCell>{t("userAgent")}</TableCell>
                <TableCell>{t("created")}</TableCell>
                <TableCell>{t("expires")}</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {(data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center">
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                        py: 2,
                      }}
                    >
                      {error ? t("unableToLoadSessions") : t("noActiveSessions")}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                paged.map((s) => (
                  <TableRow key={s.id} hover>
                    <TableCell>
                      <Typography variant="body2">{s.ipAddress ?? "—"}</Typography>
                    </TableCell>
                    <TableCell>
                      <Tooltip title={s.userAgent ?? ""}>
                        <Typography variant="body2" noWrap sx={{ maxWidth: 200 }}>
                          {s.userAgent ?? "—"}
                        </Typography>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {new Date(s.createdAt).toLocaleString()}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {new Date(s.expiresAt).toLocaleString()}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        color="error"
                        onClick={() => revoke.mutate((client) => client.revoke(s.token))}
                        disabled={revoke.isPending}
                      >
                        {t("revoke")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <AdminTablePagination {...paginationProps} />
      </Paper>
    </Stack>
  );
}

function AccountsTab() {
  const t = useTranslations("adminUsers");
  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
        }}
      >
        {t("linkedOauthAccountsAndPasskeys")}
      </Typography>
      <Alert severity="info" variant="outlined">
        {t("noAccountLinkingDataAvailable")}
      </Alert>
    </Stack>
  );
}

export function UserDetail({ userId }: { userId: string }) {
  const t = useTranslations("adminUsers");
  const requestExit = useAdminDraftExit();
  const [tab, setTab] = useAdminTab(["profile", "sessions", "accounts"]);
  const account = useAccountAdmin();
  const currentUserId = account.actorId;
  const router = useRouter();
  const impersonate = useAccountAction(userId, {
    impersonation: true,
    onSuccess: () => {
      router.push("/");
      router.refresh();
    },
  });

  const {
    data: userData,
    isLoading,
    error: readError,
  } = useQuery({
    queryKey: account.keys.detail(userId),
    enabled: Boolean(account.actorId),
    retry: false,
    queryFn: ({ signal }) => account.client.get(userId, signal),
  });

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 6,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (readError && !userData) return <Alert severity="error">{t("couldNotLoadThisAccount")}</Alert>;
  if (!userData) {
    return (
      <Box>
        <Button component={Link} href="/admin/users" startIcon={<ArrowBackIcon />} size="small">
          {t("backToUsers")}
        </Button>
        <Typography
          sx={{
            mt: 2,
            color: "text.secondary",
          }}
        >
          {t("userNotFound")}
        </Typography>
      </Box>
    );
  }

  const isSelf = userData.id === currentUserId;

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {readError && <Alert severity="error">{t("accountLoadFailedShowingLast")}</Alert>}
      <AdminPageHeader
        title={t("userDetails")}
        subtitle={t("nameEmail", { name: userData.name, email: userData.email })}
        backHref="/admin/users"
        backLabel={t("backToUsersLabel")}
      />
      <Box>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} aria-label={t("userDetailSections")}>
          <Tab id="user-tab-0" aria-controls="user-panel-0" label={t("profile")} />
          <Tab id="user-tab-1" aria-controls="user-panel-1" label={t("sessions")} />
          <Tab id="user-tab-2" aria-controls="user-panel-2" label={t("accounts")} />
        </Tabs>
      </Box>
      <Box>
        <div role="tabpanel" id={`user-panel-${tab}`} aria-labelledby={`user-tab-${tab}`}>
          {tab === 0 && (
            <ProfileTab
              key={`${account.apiUrl}:${account.actorId}:${userData.id}`}
              user={userData}
              isSelf={isSelf}
              impersonate={{
                ...impersonate,
                mutate: async () => {
                  if (await requestExit(t("impersonationChangesTheActiveAccount")))
                    impersonate.mutate((client) => client.impersonate(userId));
                },
              }}
            />
          )}
          {tab === 1 && (
            <SessionsTab key={`${account.apiUrl}:${account.actorId}:${userId}`} userId={userId} />
          )}
          {tab === 2 && <AccountsTab />}
        </div>
      </Box>
    </Stack>
  );
}
