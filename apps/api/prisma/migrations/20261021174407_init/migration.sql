-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('XTREAM', 'M3U');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('UNKNOWN', 'ONLINE', 'DEGRADED', 'OFFLINE');

-- CreateEnum
CREATE TYPE "CategoryKind" AS ENUM ('LIVE', 'VOD', 'SERIES');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TicketDurationPreset" AS ENUM ('H24', 'D7', 'D30', 'CUSTOM');

-- CreateEnum
CREATE TYPE "OverflowPolicy" AS ENUM ('REJECT', 'EVICT_OLDEST');

-- CreateEnum
CREATE TYPE "StreamEndReason" AS ENUM ('CLIENT_DISCONNECT', 'TICKET_LIMIT', 'UPSTREAM_LIMIT', 'IDLE_TIMEOUT', 'UPSTREAM_ERROR', 'PROVIDER_DISABLED', 'SERVER_SHUTDOWN');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "IpBlockScope" AS ENUM ('GLOBAL', 'TICKET');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('CONTENT', 'EPG', 'FULL');

-- CreateTable
CREATE TABLE "UpstreamProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "playlistUrl" TEXT,
    "secretsEnc" TEXT,
    "maxConnections" INTEGER NOT NULL DEFAULT 1,
    "overflowPolicy" "OverflowPolicy" NOT NULL DEFAULT 'REJECT',
    "activeConnections" INTEGER NOT NULL DEFAULT 0,
    "status" "ProviderStatus" NOT NULL DEFAULT 'UNKNOWN',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "refreshIntervalSec" INTEGER NOT NULL DEFAULT 3600,
    "lastSyncedAt" TIMESTAMP(3),
    "settings" JSONB,
    "extraHeaders" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpstreamProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "stats" JSONB,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "kind" "CategoryKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "categoryId" TEXT,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tvgId" TEXT,
    "epgChannelId" TEXT,
    "streamIcon" TEXT,
    "streamType" TEXT NOT NULL DEFAULT 'live',
    "order" INTEGER NOT NULL DEFAULT 0,
    "timeshift" BOOLEAN NOT NULL DEFAULT false,
    "tvArchiveDuration" INTEGER,
    "streamUrl" TEXT,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Movie" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "categoryId" TEXT,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "streamIcon" TEXT,
    "rating" TEXT,
    "releaseYear" INTEGER,
    "plot" TEXT,
    "containerExtension" TEXT,
    "durationSec" INTEGER,
    "addedAt" TIMESTAMP(3),
    "streamUrl" TEXT,

    CONSTRAINT "Movie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Series" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "categoryId" TEXT,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cover" TEXT,
    "plot" TEXT,
    "cast" TEXT,
    "genre" TEXT,
    "releaseDate" TEXT,
    "streamUrl" TEXT,

    CONSTRAINT "Series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeriesEpisode" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "season" INTEGER NOT NULL DEFAULT 1,
    "episode" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT,
    "containerExtension" TEXT,
    "durationSec" INTEGER,
    "addedAt" TIMESTAMP(3),
    "plot" TEXT,
    "streamIcon" TEXT,
    "streamUrl" TEXT,

    CONSTRAINT "SeriesEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpgEntry" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "channelExternalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "lang" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "stopAt" TIMESTAMP(3) NOT NULL,
    "channelId" TEXT,

    CONSTRAINT "EpgEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxConnections" INTEGER NOT NULL DEFAULT 1,
    "overflowPolicy" "OverflowPolicy" NOT NULL DEFAULT 'REJECT',
    "useCategoryFilter" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "lastConnectedAt" TIMESTAMP(3),
    "lastIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketCategory" (
    "ticketId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "TicketCategory_pkey" PRIMARY KEY ("ticketId","categoryId")
);

-- CreateTable
CREATE TABLE "IpBlock" (
    "id" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "scope" "IpBlockScope" NOT NULL DEFAULT 'GLOBAL',
    "ticketId" TEXT,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IpBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "role" "AdminRole" NOT NULL DEFAULT 'ADMIN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "meta" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamLog" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT,
    "providerId" TEXT,
    "channelId" TEXT,
    "channelName" TEXT,
    "streamId" TEXT,
    "clientIp" TEXT NOT NULL,
    "userAgent" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "endReason" "StreamEndReason",

    CONSTRAINT "StreamLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "UpstreamProvider_kind_isEnabled_idx" ON "UpstreamProvider"("kind", "isEnabled");

-- CreateIndex
CREATE INDEX "SyncRun_providerId_startedAt_idx" ON "SyncRun"("providerId", "startedAt");

-- CreateIndex
CREATE INDEX "Category_providerId_kind_idx" ON "Category"("providerId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Category_providerId_kind_externalId_key" ON "Category"("providerId", "kind", "externalId");

-- CreateIndex
CREATE INDEX "Channel_providerId_categoryId_idx" ON "Channel"("providerId", "categoryId");

-- CreateIndex
CREATE INDEX "Channel_name_idx" ON "Channel"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_providerId_externalId_key" ON "Channel"("providerId", "externalId");

-- CreateIndex
CREATE INDEX "Movie_providerId_categoryId_idx" ON "Movie"("providerId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Movie_providerId_externalId_key" ON "Movie"("providerId", "externalId");

-- CreateIndex
CREATE INDEX "Series_providerId_categoryId_idx" ON "Series"("providerId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Series_providerId_externalId_key" ON "Series"("providerId", "externalId");

-- CreateIndex
CREATE INDEX "SeriesEpisode_seriesId_idx" ON "SeriesEpisode"("seriesId");

-- CreateIndex
CREATE UNIQUE INDEX "SeriesEpisode_seriesId_externalId_key" ON "SeriesEpisode"("seriesId", "externalId");

-- CreateIndex
CREATE INDEX "EpgEntry_providerId_channelExternalId_startAt_idx" ON "EpgEntry"("providerId", "channelExternalId", "startAt");

-- CreateIndex
CREATE INDEX "EpgEntry_startAt_idx" ON "EpgEntry"("startAt");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_username_key" ON "Ticket"("username");

-- CreateIndex
CREATE INDEX "Ticket_status_expiresAt_idx" ON "Ticket"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Ticket_providerId_idx" ON "Ticket"("providerId");

-- CreateIndex
CREATE INDEX "IpBlock_scope_idx" ON "IpBlock"("scope");

-- CreateIndex
CREATE INDEX "IpBlock_ticketId_idx" ON "IpBlock"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE INDEX "AdminUser_isActive_idx" ON "AdminUser"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "StreamLog_ticketId_startedAt_idx" ON "StreamLog"("ticketId", "startedAt");

-- CreateIndex
CREATE INDEX "StreamLog_startedAt_idx" ON "StreamLog"("startedAt");

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movie" ADD CONSTRAINT "Movie_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movie" ADD CONSTRAINT "Movie_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Series" ADD CONSTRAINT "Series_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Series" ADD CONSTRAINT "Series_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeriesEpisode" ADD CONSTRAINT "SeriesEpisode_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpgEntry" ADD CONSTRAINT "EpgEntry_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpgEntry" ADD CONSTRAINT "EpgEntry_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCategory" ADD CONSTRAINT "TicketCategory_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketCategory" ADD CONSTRAINT "TicketCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpBlock" ADD CONSTRAINT "IpBlock_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamLog" ADD CONSTRAINT "StreamLog_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamLog" ADD CONSTRAINT "StreamLog_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "UpstreamProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamLog" ADD CONSTRAINT "StreamLog_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
