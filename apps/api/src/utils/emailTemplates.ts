const BRAND_COLOR = "#007b8b";
const BRAND_COLOR_DARK = "#005f6b";
const TEXT_PRIMARY = "#202124";
const TEXT_SECONDARY = "#5f6368";
const BG_BODY = "#f2f4f6";
const BG_CARD = "#ffffff";

/** Wraps email content in the shared OpenMapX layout. */
function layout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>OpenMapX</title>
</head>
<body style="margin:0;padding:0;background-color:${BG_BODY};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG_BODY};">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
    <!-- Header -->
    <tr><td style="background-color:${BRAND_COLOR};border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
      <span style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:0.3px;">Open<span style="font-weight:400;">MapX</span></span>
    </td></tr>
    <!-- Body -->
    <tr><td style="background-color:${BG_CARD};padding:36px 32px;border-left:1px solid #e8eaed;border-right:1px solid #e8eaed;">
      ${content}
    </td></tr>
    <!-- Footer -->
    <tr><td style="background-color:${BG_CARD};border-top:1px solid #e8eaed;border-radius:0 0 12px 12px;padding:20px 32px;border-left:1px solid #e8eaed;border-right:1px solid #e8eaed;border-bottom:1px solid #e8eaed;">
      <p style="margin:0;font-size:12px;line-height:18px;color:#9aa0a6;text-align:center;">
        You received this email because an action was performed on your OpenMapX account.<br>
        If you didn't request this, you can safely ignore it.
      </p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:${TEXT_PRIMARY};line-height:28px;">${text}</h1>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${TEXT_SECONDARY};">${text}</p>`;
}

function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
<tr><td align="center" style="background-color:${BRAND_COLOR};border-radius:8px;">
  <a href="${url}" target="_blank" style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.2px;">
    ${label}
  </a>
</td></tr>
</table>`;
}

function otpBlock(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;">
<tr><td align="center" style="background-color:#f2f4f6;border-radius:8px;padding:20px;">
  <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:${TEXT_PRIMARY};font-family:'Menlo','Courier New',monospace;">${code}</span>
</td></tr>
</table>`;
}

function linkFallback(url: string): string {
  return `<p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#9aa0a6;word-break:break-all;">
  If the button doesn't work, copy this link into your browser:<br>
  <a href="${url}" style="color:${BRAND_COLOR_DARK};">${url}</a>
</p>`;
}

export function resetPasswordEmail(url: string): { subject: string; text: string; html: string } {
  return {
    subject: "Reset your password — OpenMapX",
    text: `Reset your password\n\nClick the link below to choose a new password:\n\n${url}\n\nIf you didn't request this, you can safely ignore this email.`,
    html: layout(
      heading("Reset your password") +
        paragraph(
          "We received a request to reset the password for your account. Click the button below to choose a new password.",
        ) +
        button("Reset Password", url) +
        linkFallback(url),
    ),
  };
}

export function verifyEmailEmail(url: string): { subject: string; text: string; html: string } {
  return {
    subject: "Verify your email — OpenMapX",
    text: `Welcome to OpenMapX!\n\nPlease verify your email by visiting the link below:\n\n${url}`,
    html: layout(
      heading("Verify your email") +
        paragraph(
          "Welcome to OpenMapX! Please confirm your email address by clicking the button below.",
        ) +
        button("Verify Email", url) +
        linkFallback(url),
    ),
  };
}

export function twoFactorOtpEmail(otp: string): { subject: string; text: string; html: string } {
  return {
    subject: "Your OpenMapX verification code",
    text: `Your verification code is: ${otp}\n\nThis code expires in 5 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
    html: layout(
      heading("Verification code") +
        paragraph("Use the code below to complete your sign-in. It expires in 5 minutes.") +
        otpBlock(otp),
    ),
  };
}

export function emailOtpEmail(
  otp: string,
  type: string,
): { subject: string; text: string; html: string } {
  const config: Record<string, { subject: string; title: string; description: string }> = {
    "sign-in": {
      subject: "Sign in to OpenMapX",
      title: "Sign-in code",
      description: "Use the code below to sign in to your account. It expires in 5 minutes.",
    },
    "email-verification": {
      subject: "Verify your email — OpenMapX",
      title: "Verify your email",
      description:
        "Welcome to OpenMapX! Use the code below to verify your email address. It expires in 5 minutes.",
    },
    "forget-password": {
      subject: "Reset your password — OpenMapX",
      title: "Password reset code",
      description: "Use the code below to reset your password. It expires in 5 minutes.",
    },
  };

  const c = config[type] ?? {
    subject: "OpenMapX verification code",
    title: "Verification code",
    description: "Use the code below to continue. It expires in 5 minutes.",
  };

  return {
    subject: c.subject,
    text: `${c.title}\n\nYour code is: ${otp}\n\nThis code expires in 5 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
    html: layout(heading(c.title) + paragraph(c.description) + otpBlock(otp)),
  };
}
