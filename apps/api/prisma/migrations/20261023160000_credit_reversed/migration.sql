-- A citation credit clawed back because the buyer's payment behind it was refunded or charged back.
ALTER TYPE "CreditStatus" ADD VALUE IF NOT EXISTS 'reversed';
