# Growth modules patch

This patch adds backend support for platform settings, promo codes, Stripe promo links, invite links, and redemption tracking.

## Added Prisma models

- `PlatformSetting` for global/region-scoped config flags.
- `Promotion` for Stripe promo codes, internal trial promos, and campaign tracking.
- `PromotionRedemption` for per-user promo usage.
- `InviteLink` for invite-only/region-specific registration links.
- `InviteRedemption` for per-user invite usage.

`Subscription` also now stores `promotionCode` and `inviteCode` metadata.

## Added services

- `src/services/settingsService.ts`
- `src/services/promotionService.ts`
- `src/services/inviteService.ts`

## Added/updated API behavior

### Public

- `GET /api/public/settings?regionId=...`
- `GET /api/public/invites/:code`
- `GET /api/public/promotions/:code?regionId=...`

### Auth

`POST /api/auth/register` now accepts:

```json
{
  "email": "user@example.com",
  "username": "user",
  "password": "secret123",
  "regionId": "region_id",
  "inviteCode": "optional_invite",
  "promoCode": "optional_promo"
}
```

Invite links override the provided `regionId`. `INTERNAL_TRIAL` promotions can add extra trial days.

### Payments

`POST /api/payments/checkout` now accepts:

```json
{
  "planId": "plan_id",
  "promoCode": "LAUNCH50",
  "inviteCode": "optional_invite"
}
```

Checkout now enables Stripe's promo code box by default using `allow_promotion_codes`. If a matching local `Promotion` has `type = STRIPE_PROMO` and a `stripePromotionCodeId`, it is applied directly to the Checkout Session.

### Sub-admin / regional-admin

- `GET /api/sub-admin/settings`
- `PUT /api/sub-admin/settings/:key`
- `GET /api/sub-admin/promotions`
- `POST /api/sub-admin/promotions`
- `PATCH /api/sub-admin/promotions/:promotionId`
- `GET /api/sub-admin/invites`
- `POST /api/sub-admin/invites`
- `PATCH /api/sub-admin/invites/:inviteId`

Because the same router is mounted at `/api/sub-admin`, regional admins can manage these for their own region. Super admins can pass `regionId` like the existing sub-admin routes.

## Suggested settings keys

- `auth.inviteOnly` boolean
- `billing.promoCodesEnabled` boolean
- `trial.days` number
- `trial.dailyPublishLimit` number
- `ui.supportEmail` string

## After applying

Run:

```bash
npm install
npx prisma migrate dev
npx prisma generate
npm run build
```

For production:

```bash
npx prisma migrate deploy
npx prisma generate
npm run build
```
