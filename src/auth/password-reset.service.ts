import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail/mail.service';
import { createHash, randomBytes } from 'crypto';

export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  async requestReset(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return; // never reveal whether the email exists
    const rawToken = randomBytes(32).toString('hex');
    const ttlMinutes = Number(
      this.config.get('PASSWORD_RESET_TTL_MINUTES') ?? 15,
    );
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hash(rawToken),
          expiresAt: new Date(now.getTime() + ttlMinutes * 60000),
        },
      }),
    ]);
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
