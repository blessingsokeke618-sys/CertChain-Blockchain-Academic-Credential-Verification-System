import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] aria-invalid:ring-destructive/30 aria-invalid:border-destructive",
    {
        variants: {
            variant: {
                // Primary brand action — deep navy
                default:
                    'bg-primary text-primary-foreground shadow-sm hover:bg-[color-mix(in_srgb,var(--primary)_90%,white)] hover:shadow-md',
                brand: 'bg-primary text-primary-foreground shadow-sm hover:bg-[color-mix(in_srgb,var(--primary)_90%,white)] hover:shadow-md',
                // Gold accent — high-emphasis, sparing use
                gold: 'bg-gold text-gold-foreground shadow-sm hover:bg-[color-mix(in_srgb,var(--gold)_90%,black)] hover:shadow-md',
                // Neutral surface button
                surface:
                    'border border-border bg-card text-card-foreground shadow-xs hover:bg-secondary hover:shadow-sm',
                outline:
                    'border border-input bg-transparent text-foreground shadow-xs hover:bg-secondary hover:border-border',
                secondary: 'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_srgb,var(--secondary)_92%,black)]',
                ghost: 'text-foreground hover:bg-secondary',
                destructive:
                    'bg-destructive text-destructive-foreground shadow-sm hover:bg-[color-mix(in_srgb,var(--destructive)_90%,black)]',
                success:
                    'bg-success text-success-foreground shadow-sm hover:bg-[color-mix(in_srgb,var(--success)_90%,black)]',
                link: 'text-primary underline-offset-4 hover:underline',
            },
            size: {
                default: 'h-10 px-4 py-2 has-[>svg]:px-3.5',
                sm: 'h-9 rounded-md gap-1.5 px-3 text-[0.8125rem] has-[>svg]:px-2.5',
                lg: 'h-11 rounded-lg px-6 text-[0.9375rem] has-[>svg]:px-5',
                xl: 'h-13 rounded-xl px-8 text-base font-semibold has-[>svg]:px-6',
                icon: 'size-10',
                'icon-sm': 'size-9',
                'icon-lg': 'size-11',
            },
        },
        defaultVariants: {
            variant: 'default',
            size: 'default',
        },
    },
);

function Button({
    className,
    variant,
    size,
    asChild = false,
    type,
    ...props
}: React.ComponentProps<'button'> &
    VariantProps<typeof buttonVariants> & {
        asChild?: boolean;
    }) {
    const Comp = asChild ? Slot : 'button';

    return (
        <Comp
            type={asChild ? undefined : (type ?? 'button')}
            data-slot="button"
            className={cn(buttonVariants({ variant, size, className }))}
            {...props}
        />
    );
}

export { Button, buttonVariants };
