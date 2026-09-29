export class ResendEmailSender {
  constructor({
    apiKey = process.env.RESEND_API_KEY,
    from = process.env.BIZNORYX_EMAIL_FROM,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.from = from;
    this.fetchImpl = fetchImpl;
  }

  async sendVerificationCode({
    to,
    code,
    expiresAt,
    challengeId,
  }) {
    if (!this.apiKey) {
      throw new EmailDeliveryError(
        "RESEND_API_KEY is not configured.",
      );
    }

    if (!this.from) {
      throw new EmailDeliveryError(
        "BIZNORYX_EMAIL_FROM is not configured.",
      );
    }

    if (typeof this.fetchImpl !== "function") {
      throw new EmailDeliveryError(
        "Email transport is unavailable.",
      );
    }

    const minutes = Math.max(
      1,
      Math.ceil(
        (new Date(expiresAt).getTime() - Date.now()) /
          60_000,
      ),
    );

    const response = await this.fetchImpl(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `email-verification/${challengeId}`,
        },

        body: JSON.stringify({
          from: this.from,

          to: [to],

          subject: "Your BIZNORYX verification code",

          text: [
            "Verify your BIZNORYX email address.",
            "",
            `Your verification code is: ${code}`,
            "",
            `This code expires in ${minutes} minutes.`,
            "",
            "If you did not request this code, you can ignore this email.",
          ].join("\n"),

          html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#142018;">
              <div style="font-size:22px;font-weight:700;margin-bottom:32px;">
                BIZNORYX<span style="color:#72a96b;">.</span>
              </div>

              <h1 style="font-size:24px;line-height:1.3;margin:0 0 16px;">
                Verify your email
              </h1>

              <p style="font-size:16px;line-height:1.6;color:#536057;">
                Use the verification code below to finish creating your BIZNORYX account.
              </p>

              <div style="
                margin:28px 0;
                padding:22px;
                background:#f2f6f1;
                border:1px solid #dce7da;
                border-radius:10px;
                text-align:center;
                font-size:32px;
                font-weight:700;
                letter-spacing:8px;
              ">
                ${code}
              </div>

              <p style="font-size:14px;line-height:1.6;color:#6b756e;">
                This code expires in ${minutes} minutes.
              </p>

              <p style="font-size:14px;line-height:1.6;color:#6b756e;">
                If you did not request this code, you can safely ignore this email.
              </p>
            </div>
          `,
        }),
      },
    );

    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new EmailDeliveryError(
        payload?.message ??
          "Unable to send verification email.",
        response.status,
      );
    }

    if (!payload?.id) {
      throw new EmailDeliveryError(
        "Email provider returned an invalid response.",
      );
    }

    return {
      provider: "resend",
      messageId: payload.id,
    };
  }
}

export class EmailDeliveryError extends Error {
  constructor(message, status = null) {
    super(message);

    this.name = "EmailDeliveryError";
    this.status = status;
  }
}