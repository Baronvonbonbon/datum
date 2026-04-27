/**
 * DATUM Publisher — Gutenberg block editor script.
 *
 * Registers the datum-publisher/ad-slot block using wp.element.createElement
 * (no JSX / no build step required).
 */
( function ( wp ) {
	var el               = wp.element.createElement;
	var __               = wp.i18n.__;
	var registerBlockType = wp.blocks.registerBlockType;
	var InspectorControls = wp.blockEditor.InspectorControls;
	var PanelBody        = wp.components.PanelBody;
	var SelectControl    = wp.components.SelectControl;
	var Placeholder      = wp.components.Placeholder;

	var SLOT_FORMATS = [
		{ label: __( 'Medium Rectangle (300×250)', 'datum-publisher' ), value: 'medium-rectangle' },
		{ label: __( 'Leaderboard (728×90)',        'datum-publisher' ), value: 'leaderboard'      },
		{ label: __( 'Wide Skyscraper (160×600)',   'datum-publisher' ), value: 'wide-skyscraper'  },
		{ label: __( 'Half Page (300×600)',          'datum-publisher' ), value: 'half-page'        },
		{ label: __( 'Mobile Banner (320×50)',       'datum-publisher' ), value: 'mobile-banner'    },
		{ label: __( 'Square (250×250)',             'datum-publisher' ), value: 'square'           },
		{ label: __( 'Large Rectangle (336×280)',    'datum-publisher' ), value: 'large-rectangle'  },
	];

	var SLOT_SIZES = {
		'medium-rectangle': { w: 300, h: 250 },
		'leaderboard':      { w: 728, h: 90  },
		'wide-skyscraper':  { w: 160, h: 600 },
		'half-page':        { w: 300, h: 600 },
		'mobile-banner':    { w: 320, h: 50  },
		'square':           { w: 250, h: 250 },
		'large-rectangle':  { w: 336, h: 280 },
	};

	registerBlockType( 'datum-publisher/ad-slot', {
		title:       __( 'DATUM Ad Slot', 'datum-publisher' ),
		description: __( 'Place a DATUM ad slot. Advertisers bid in real time; you earn DOT for verified impressions.', 'datum-publisher' ),
		category:    'embeds',
		icon:        'image-crop',
		keywords:    [ 'datum', 'ad', 'advertisement', 'crypto', 'web3', 'dot' ],
		supports: {
			html:  false,
			align: [ 'center', 'wide' ],
		},
		attributes: {
			format: {
				type:    'string',
				default: 'medium-rectangle',
			},
		},

		edit: function ( props ) {
			var format = props.attributes.format || 'medium-rectangle';
			var size   = SLOT_SIZES[ format ] || SLOT_SIZES[ 'medium-rectangle' ];
			var label  = ( SLOT_FORMATS.find( function ( f ) { return f.value === format; } ) || {} ).label || format;

			var controls = el(
				InspectorControls,
				{ key: 'controls' },
				el(
					PanelBody,
					{
						title:       __( 'Slot Settings', 'datum-publisher' ),
						initialOpen: true,
					},
					el( SelectControl, {
						label:    __( 'Ad Format', 'datum-publisher' ),
						value:    format,
						options:  SLOT_FORMATS,
						onChange: function ( val ) {
							props.setAttributes( { format: val } );
						},
					} )
				)
			);

			var preview = el(
				'div',
				{
					key:       'preview',
					className: 'datum-block-preview',
					style: {
						width:          size.w + 'px',
						maxWidth:       '100%',
						height:         size.h + 'px',
						background:     '#f6f7f7',
						border:         '2px dashed #0073aa',
						borderRadius:   '4px',
						display:        'flex',
						flexDirection:  'column',
						alignItems:     'center',
						justifyContent: 'center',
						fontFamily:     '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
						color:          '#0073aa',
						boxSizing:      'border-box',
						padding:        '8px',
					},
				},
				el(
					'span',
					{
						style: {
							fontSize:   '13px',
							fontWeight: '600',
							marginBottom: '4px',
						},
					},
					'⬡ DATUM Ad Slot'
				),
				el(
					'span',
					{
						style: {
							fontSize: '11px',
							opacity:  '0.8',
						},
					},
					label
				)
			);

			return [ controls, preview ];
		},

		// Dynamic block — PHP renders the front end.
		save: function () {
			return null;
		},
	} );
} )( window.wp );
